/**
 * 当前项目根。
 *
 * 宿主没有暴露「工作区已切换」的推送（仅独立面板窗有事件），因此沿用宿主
 * 内置 pi.files 的做法：低频轮询 workspace.get()，路径一变就整体重载。
 * workspace.get 不需要任何权限，且返回的是绝对路径。
 */

import { invoke } from "./bridge";

export type Workspace = { path: string; name: string };

const POLL_MS = 2000;

export function getWorkspace(): Promise<Workspace | null> {
  return invoke<Workspace | null>("workspace.get").catch(() => null);
}

export function watchWorkspace(onChange: (workspace: Workspace | null) => void): () => void {
  let last: string | null | undefined;

  const tick = async () => {
    const workspace = await getWorkspace();
    const key = workspace?.path ?? null;
    if (key === last) return;
    last = key;
    onChange(workspace);
  };

  void tick();
  const timer = window.setInterval(() => void tick(), POLL_MS);
  return () => window.clearInterval(timer);
}
