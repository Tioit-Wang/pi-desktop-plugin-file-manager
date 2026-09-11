/**
 * 主题与语言。
 *
 * 嵌入态（右侧工作面板里的 WebContentsView）**收不到**宿主的
 * `appearance:changed` 事件——preload 在 isEmbeddedPanel() 时提前 return，
 * 既不注入窗口 chrome 也不广播事件（plugin-panel.ts:334，且
 * PluginPanelHost.broadcast 只遍历独立窗口）。所以这里以轮询为准，
 * 同时保留事件订阅，便于将来宿主补上或本页被放进独立窗口时立刻生效。
 */

import { invoke, on } from "./bridge";

export type Appearance = {
  theme?: string;
  base?: "light" | "dark" | "system";
  locale?: string;
};

export type Base = "light" | "dark";
export type Locale = "en" | "zh";

const POLL_MS = 2000;

export function baseOf(appearance: Appearance | null): Base {
  if (appearance?.base === "light" || appearance?.base === "dark") return appearance.base;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function localeOf(appearance: Appearance | null): Locale {
  const tag = String(appearance?.locale ?? navigator.language ?? "").toLowerCase();
  return tag.startsWith("zh") ? "zh" : "en";
}

export function applyBase(base: Base): void {
  document.documentElement.dataset.base = base;
  document.documentElement.style.colorScheme = base;
}

/**
 * 持续同步宿主外观。返回取消函数。
 * onChange 只在真的变化时触发，避免每次轮询都重渲染。
 */
export function watchAppearance(
  onChange: (appearance: Appearance, base: Base, locale: Locale) => void,
): () => void {
  let last = "";

  const push = (appearance: Appearance | null) => {
    const base = baseOf(appearance);
    const locale = localeOf(appearance);
    const key = `${base}:${locale}`;
    if (key === last) return;
    last = key;
    applyBase(base);
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    onChange(appearance ?? {}, base, locale);
  };

  const read = () => {
    invoke<Appearance>("app.getAppearance")
      .then(push)
      .catch(() => push(null));
  };

  read();
  const unsubscribe = on("appearance:changed", (payload) => push(payload as Appearance));
  const timer = window.setInterval(read, POLL_MS);

  return () => {
    window.clearInterval(timer);
    unsubscribe();
  };
}
