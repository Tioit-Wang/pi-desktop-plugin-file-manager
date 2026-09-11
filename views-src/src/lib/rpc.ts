/**
 * 视图 ↔ 插件主进程的通道契约。这里是唯一真相来源：
 * 任何一侧改字段，都从改这个文件开始。
 *
 * 全部经 window.pluginBridge.invoke("fm.*", payload) 转发到 main.js 的
 * onPanelInvoke。宿主对自定义通道的超时是 30s，所以遍历类操作一律分页。
 */

import type { T } from "../i18n";

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtimeMs: number;
  ignored: boolean;
  isSymlink: boolean;
  /** 符号链接指向根目录之外：不展开、不可读。 */
  outside: boolean;
};

export type Failure = { ok: false; code: string; message: string };

export type Prefs = {
  splitRatio: number;
  showIgnored: boolean;
  /** Markdown 默认打开为预览还是编辑；只对 .md/.markdown/.mdx 生效。 */
  mdPreview: boolean;
};

export type Limits = {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
};

export type HelloResponse = {
  ok: true;
  root: { path: string; name: string } | null;
  limits: Limits;
  ignoreFiles: string[];
  prefs: Prefs;
};

export type ListResponse = {
  ok: true;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  /** 项目里存在生效的忽略规则；false 表示「无规则，全部展示」。 */
  ignoreActive: boolean;
};

export type TextRead = {
  ok: true;
  kind: "text";
  path: string;
  text: string;
  eol: "lf" | "crlf";
  bom: boolean;
  size: number;
  mtimeMs: number;
};

export type OpaqueRead = {
  ok: true;
  kind: "binary" | "image" | "tooLarge";
  path: string;
  size: number;
  mtimeMs: number;
};

export type ReadResponse = TextRead | OpaqueRead;

export type WriteOk = { ok: true; mtimeMs: number; size: number };

export type ConflictFailure = {
  ok: false;
  code: "CONFLICT";
  message: string;
  mtimeMs: number;
  size: number;
};

export type WriteResponse = WriteOk | ConflictFailure | Failure;

export type EntryResponse = { ok: true; entry: FileEntry | null } | Failure;

export type SearchHit = { name: string; path: string; isDirectory: boolean };

export type SearchResponse = {
  ok: true;
  matches: SearchHit[];
  nextCursor: string | null;
  done: boolean;
  scanned: number;
};

export type PrefsResponse = { ok: true; prefs: Prefs } | Failure;

export type WriteRequest = {
  path: string;
  text: string;
  expectedMtimeMs: number;
  expectedSize: number;
  eol: "lf" | "crlf";
  bom: boolean;
};

/** CONFLICT 是带当前磁盘状态的失败，需要 discriminated 检查而不是比 code。 */
export function isConflict(response: WriteResponse): response is ConflictFailure {
  return !response.ok && response.code === "CONFLICT" && "mtimeMs" in response;
}

export const channels = {
  hello: "fm.hello",
  prefsGet: "fm.prefs.get",
  prefsSet: "fm.prefs.set",
  list: "fm.list",
  read: "fm.read",
  write: "fm.write",
  create: "fm.create",
  rename: "fm.rename",
  move: "fm.move",
  search: "fm.search",
} as const;

/** 把失败响应统一成人话，供 UI 直接展示。 */
export function failureMessage(failure: Failure, t: T): string {
  switch (failure.code) {
    case "NO_WORKSPACE":
      return t("noWorkspace");
    case "DENIED_PATH":
      return t("errDenied");
    case "ESCAPE":
    case "ABSOLUTE_PATH":
    case "SYMLINK_ESCAPE":
      return t("errEscape");
    case "EXISTS":
      return t("errExists");
    case "INVALID_NAME":
      return t("errName");
    case "TOO_LARGE":
      return t("tooLarge");
    case "CONFLICT":
      return t("conflictTitle");
    case "NOT_FOUND":
      return t("errNotFound");
    case "UNSUPPORTED":
      return t("errUnsupported");
    default:
      return failure.message || failure.code;
  }
}
