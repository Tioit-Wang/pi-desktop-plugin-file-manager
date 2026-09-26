/**
 * git 状态在界面上的那一层：徽标长什么样、tooltip 怎么写、从已加载的目录里怎么
 * 查一个路径的状态。
 *
 * 这里刻意不碰任何 git 输出格式——porcelain / numstat / unified diff 的解析都在
 * main.js（那边有 verify-git.mjs 钉住形态）。这一层只回答「界面怎么讲这件事」。
 */

import type { CopyKey, T } from "../i18n";
import { parentOf } from "./format";
import type { FileEntry, GitEntryStatus, GitStatusKind, GitSummary } from "./rpc";

/** 徽标字母：与 git 自己那套心智模型一致（M/A/D/R/U），一眼能对上。 */
const GLYPH: Record<GitStatusKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  conflicted: "U",
  typechange: "T",
};

/** 状态本身的名字（tooltip / 差异视图标题用）。 */
const STATUS_KEY: Record<GitStatusKind, CopyKey> = {
  added: "gitAdded",
  modified: "gitModified",
  deleted: "gitDeleted",
  renamed: "gitRenamed",
  conflicted: "gitConflicted",
  typechange: "gitTypechange",
};

export function gitGlyph(status: GitStatusKind): string {
  return GLYPH[status] ?? "?";
}

/**
 * 徽标颜色。刻意用与主题无关的色相（绿=新增 / 琥珀=修改 / 红=删除 / 紫=冲突），
 * 而不是「成功 / 危险」那套语义色：删除在这里不是错误，红只是「这一类变化」的
 * 约定，用户扫一眼要能立刻分开新增与修改。
 */
const COLOR: Record<GitStatusKind, string> = {
  added: "var(--git-added)",
  modified: "var(--git-modified)",
  deleted: "var(--git-deleted)",
  renamed: "var(--git-renamed)",
  conflicted: "var(--git-conflicted)",
  typechange: "var(--git-modified)",
};

export function gitColor(status: GitStatusKind): string {
  return COLOR[status] ?? "var(--muted)";
}

/** 一行的状态说明：状态名 + 暂存 / 未跟踪 + 增删行数。 */
export function gitTitle(git: GitEntryStatus, t: T): string {
  const parts = [t(STATUS_KEY[git.status])];
  if (git.untracked) parts.push(t("gitUntracked"));
  else if (git.staged) parts.push(t("gitStaged"));
  if (typeof git.changed === "number") {
    parts.push(t("gitChangedFiles", { count: git.changed }));
  } else if (git.added > 0 || git.deleted > 0) {
    parts.push(`+${git.added} −${git.deleted}`);
  }
  return parts.join(" · ");
}

/** 头部那一行概览：分支 + 各状态的文件数；没有变化时给一句「工作区干净」。 */
export function gitSummaryText(git: GitSummary | null, t: T): string | null {
  if (!git?.available) return null;
  const counts = git.counts;
  if (!counts) return null;
  const parts: string[] = [];
  if (git.branch) parts.push(git.branch);
  const changed = (git.total ?? 0) > 0;
  if (changed) {
    if (counts.modified > 0) parts.push(t("gitCountModified", { count: counts.modified }));
    if (counts.added > 0) parts.push(t("gitCountAdded", { count: counts.added }));
    if (counts.deleted > 0) parts.push(t("gitCountDeleted", { count: counts.deleted }));
    if (counts.renamed > 0) parts.push(t("gitCountRenamed", { count: counts.renamed }));
    if (counts.conflicted > 0) parts.push(t("gitCountConflicted", { count: counts.conflicted }));
    if (git.truncated) parts.push(t("gitTruncated"));
  } else {
    parts.push(t("gitClean"));
  }
  return parts.join(" · ");
}

/**
 * 目录树里给一条路径找状态：先看它自己那一行，没有（目录还没展开）就一路往上找
 * 祖先目录的汇总。主进程给的目录徽标本来就是子树汇总，所以往上找得到答案。
 *
 * directories 的类型写成结构而不是 DirState，是为了不依赖 components/Tree.tsx
 * （那个文件又依赖本文件）。
 */
export function lookupGit(
  directories: Map<string, { entries?: FileEntry[] }>,
  relPath: string,
): GitEntryStatus | null {
  let current = relPath;
  for (;;) {
    // 条目住在**它所在的目录**里，不是以自己为键——先按父目录去取。
    const parent = parentOf(current);
    const entries = directories.get(parent)?.entries;
    if (entries) {
      const hit = entries.find((entry) => entry.path === current);
      // 这一行在已加载的目录里：它的 git 就是答案。没有变化时是 null，
      // 那也是答案——不能因为「祖先有变化」就把这个干净的文件说成脏的。
      if (hit) return hit.git ?? null;
    }
    // 这一行所在的目录还没展开：往上一级看祖先目录的子树汇总。
    if (!current) return null;
    current = parent;
  }
}
