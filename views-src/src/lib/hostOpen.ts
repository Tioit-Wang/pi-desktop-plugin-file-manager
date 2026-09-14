/**
 * 宿主「打开这个文件」请求的投递路径。
 *
 * 宿主只用两条路径递同一条请求，视图两条都要接住：
 *   ① 视图入口 URL 的查询串 `?piViewOpen=<encodeURIComponent(path)>`
 *      ——宿主加载 views/index.html 时附上，挂载时同步读一次；这是唯一不会
 *        和页面抢跑的通道：还没跑起来的文档收不到事件，但一定读得到自己的 URL。
 *   ② preload 推送 `pi-plugin-panel-event:view:open`，payload 是 `{ path }`
 *      ——用于视图已经加载完成之后的实时更新（宿主在页面加载完成前不会推送，
 *        而是改写 URL 重新加载，所以这里不会漏掉任何一次请求）。
 *
 * 两条路径带去重：入口查询串与紧随其后的同一条推送只算一次。重复到达的请求
 * 不会第二次打开文件，也就不会用脏缓冲守卫再问用户一遍。
 *
 * 路径形态只有两种：项目内的 POSIX 相对路径（`src/dir/openimage.js`），或者
 * 项目之外的**绝对** OS 路径（会话临时目录 / 附件，如
 * `C:\Users\x\AppData\Roaming\pi-desktop\scratch\<sessionId>\tmp.js`）。绝对
 * 路径在视图侧不参与目录树展开与选中，读写时带 `external` 标记交给主进程。
 */

import { on } from "./bridge";

/** preload 剥掉 `pi-plugin-panel-event:` 前缀后交给 bridge.on 的事件名。 */
export const HOST_OPEN_EVENT = "view:open";

/** 宿主附加在视图入口 URL 上的一次性载荷名。 */
export const HOST_OPEN_QUERY_KEY = "piViewOpen";

export type HostOpenRequest = {
  path: string;
};

/**
 * 绝对路径判定：POSIX 根、Windows 盘符、UNC 前缀。其余一律按项目内相对路径。
 * 三种形态与宿主侧的约定一致（会话临时目录 / 附件走的就是绝对路径）。
 */
export function isExternalPath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.startsWith("\\\\")
  );
}

/** 入口查询串 → 打开路径；没有载荷时返回 null。宿主给的是 encodeURIComponent 后的值。 */
export function readInitialOpenPath(search: string): string | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(HOST_OPEN_QUERY_KEY);
  } catch {
    return null;
  }
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/** payload → 打开请求；形状不对的一律忽略（宿主加新字段不该弄坏旧视图）。 */
export function readOpenRequest(payload: unknown): HostOpenRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { path?: unknown };
  if (typeof candidate.path !== "string" || !candidate.path.trim()) return null;
  return { path: candidate.path };
}

/**
 * 订阅两条投递路径，把去重后的请求交给 onRequest。返回取消函数。
 */
export function watchHostOpenRequests(
  onRequest: (request: HostOpenRequest) => void,
): () => void {
  let lastPath: string | null = null;

  const deliver = (request: HostOpenRequest) => {
    if (request.path === lastPath) return;
    lastPath = request.path;
    onRequest(request);
  };

  // ② 先订阅：推送是「过了这村没这店」的，晚一步就永远收不到。
  const unsubscribe = on(HOST_OPEN_EVENT, (payload) => {
    const request = readOpenRequest(payload);
    if (request) deliver(request);
  });

  // ① 查询串同步读掉；它比同一条推送先到，所以推送会被去重挡下。
  const fromQuery = readInitialOpenPath(window.location.search);
  if (fromQuery) deliver({ path: fromQuery });

  return () => unsubscribe();
}
