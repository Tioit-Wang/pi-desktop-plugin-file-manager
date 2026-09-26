/**
 * 收到一批外部改动之后，视图该怎么反应（0.8.0）。
 *
 * 这一段是整个监听里**唯一有判断**的地方，单独拎成纯函数是为了能被离线断言：
 * 「什么时候该悄悄重读、什么时候必须先问一句」如果埋在组件里就只能靠手点，
 * 而这两条规则一旦写反，后果都是「用户的编辑被系统弄丢」这种不可接受的事。
 *
 * 规则只有三条，都写在这里：
 *   ① 变化的**父目录**要重列一次（mtime / 体积 / git 徽标 / 新建与删除都在那里跟上）。
 *   ② 打开的文件正好被改了、**且没有未保存的改动** → 悄悄重新读取。
 *   ③ 打开的文件正好被改了、**但有未保存的改动** → 只提示，不动内容。
 *      静默覆盖用户刚敲的字是最糟的一种「自动」；把选择权交回去就是了。
 */

import { parentOf } from "./format";

/** 一次外部改动最多顺手刷新这么多个目录（批量改动时不至于把面板打满）。 */
export const WATCH_MAX_DIR_REFRESH = 8;

export type WatchDecision = {
  /** 要重新列一遍的目录（只含已展开的那部分由调用方再筛一遍）。 */
  refreshDirs: string[];
  /** 打开的文件可以悄悄重新读取。 */
  reload: boolean;
  /** 打开的文件被改了但有未保存改动：只提示，不覆盖。 */
  warn: boolean;
};

export function decideWatchAction(input: {
  changed: string[];
  /** 游标落到有界历史之外：可能还有没看到的变化。 */
  stale: boolean;
  openPath: string | null;
  dirty: boolean;
}): WatchDecision {
  const targets = new Set<string>();
  for (const path of input.changed) targets.add(parentOf(path));
  if (input.stale) targets.add("");

  const open = input.openPath;
  // 变化列表非空却没提到打开的文件：这个文件与这批变化无关。
  // （stale 时列表可能漏掉它，所以那种情况按「可能有关」处理。）
  const mentioned = input.changed.length === 0 ? Boolean(input.stale) : input.changed.includes(open ?? "");

  return {
    refreshDirs: [...targets].slice(0, WATCH_MAX_DIR_REFRESH),
    reload: Boolean(open) && mentioned && !input.dirty,
    warn: Boolean(open) && mentioned && input.dirty,
  };
}
