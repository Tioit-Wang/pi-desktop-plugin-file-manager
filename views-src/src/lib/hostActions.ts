/**
 * 由宿主代为执行的两个动作：用默认应用打开、在文件夹中显示。
 *
 * 和插件自己的读写不同，这两个**必须**走宿主网关：只有宿主进程能调起系统程序，
 * 也只有它能拿到真实路径。因此 manifest 里声明了 `fs.read`（root workspace、
 * scope `**`）——与内置 Files 视图逐项相同——这两个通道会按声明的范围校验，
 * 越界会被宿主自己拒掉。
 *
 * 契约（见宿主 plugin-runtime.ts）：参数是**工作区相对路径**，且**只接受文件**，
 * 目录会返回 INVALID_ARGUMENT，所以调用方要对目录禁用这两个动作。
 */

import { invoke } from "./bridge";

type HostResponse = { ok?: boolean; message?: string } | undefined;

/**
 * 宿主通道失败时有两种表现：抛错（preload 拒绝）或返回 `{ ok: false }`。
 * 这里统一成抛错，调用方只写一个 catch。
 */
async function runHostAction(channel: string, path: string): Promise<void> {
  const response = await invoke<HostResponse>(channel, { path });
  if (response && response.ok === false) {
    throw new Error(response.message ?? "the host refused the request");
  }
}

export function openWithDefaultApp(path: string): Promise<void> {
  return runHostAction("fs.openDefault", path);
}

export function revealInFileManager(path: string): Promise<void> {
  return runHostAction("fs.reveal", path);
}
