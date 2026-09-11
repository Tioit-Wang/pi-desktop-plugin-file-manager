/**
 * window.pluginBridge 的类型化包装。
 *
 * 视图是沙箱页面，没有 Node，也没有全局 pi；只有宿主注入的 pluginBridge
 * （preload/plugin-panel.ts）。在普通浏览器里打开时会缺失，此时给出明确的
 * 报错而不是静默失败，方便 `pnpm dev` 时看出来自己在宿主外面。
 */

type Bridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
};

declare global {
  interface Window {
    pluginBridge?: Bridge;
  }
}

export const hasBridge = (): boolean => typeof window.pluginBridge?.invoke === "function";

export async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const bridge = window.pluginBridge;
  if (!bridge?.invoke) {
    throw Object.assign(new Error("plugin bridge unavailable (open this view inside PI-Desktop)"), {
      code: "NO_BRIDGE",
    });
  }
  return (await bridge.invoke(channel, payload ?? {})) as T;
}

/** 订阅宿主推送；嵌入态下宿主不会推送，返回的取消函数仍然安全可调。 */
export function on(event: string, handler: (payload: unknown) => void): () => void {
  const bridge = window.pluginBridge;
  if (!bridge?.on) return () => {};
  try {
    return bridge.on(event, handler);
  } catch {
    return () => {};
  }
}
