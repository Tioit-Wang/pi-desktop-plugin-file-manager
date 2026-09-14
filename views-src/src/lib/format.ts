export function formatSize(bytes?: number): string {
  if (typeof bytes !== "number") return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(ms?: number, locale = "en"): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * 视图里的路径有两种形态：项目内的 POSIX 相对路径，以及宿主请求打开的
 * 项目外绝对路径（Windows 下用 `\`）。父子拆分要同时认两种分隔符。
 */
const lastSeparator = (path: string): number =>
  Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

export const parentOf = (path: string): string => {
  const index = lastSeparator(path);
  return index === -1 ? "" : path.slice(0, index);
};

export const baseNameOf = (path: string): string => path.slice(lastSeparator(path) + 1);

export const childPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name;
