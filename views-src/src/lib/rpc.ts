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
  /**
   * 左侧文件列表是否收起。宿主请求打开文件时会强制收起，并随设置持久化；
   * splitRatio 照旧保留，重新展开时按原宽度恢复。
   */
  treeCollapsed: boolean;
  showIgnored: boolean;
  /** Markdown 默认打开为预览还是编辑；只对 .md/.markdown/.mdx 生效。 */
  mdPreview: boolean;
  /** CSV/TSV 默认打开为表格还是源码。 */
  csvTable: boolean;
  /** JSON 默认打开为折叠树还是源码。 */
  jsonTree: boolean;
  /** 表格每页行数（100–5000，100 的整数倍；默认 1000）。 */
  tablePageSize: number;
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

/**
 * 图片与音视频把字节以 data URI 带过来——面板是 file:// 的沙箱页，
 * 没有文件系统，相对路径只会指回视图自己。
 */
export type DataRead = {
  ok: true;
  kind: "image" | "media";
  path: string;
  size: number;
  mtimeMs: number;
  /** image/png、video/mp4 这类；视图据此选 <img> 还是 <video>/<audio>。 */
  mime: string;
  dataUri: string;
};

/** 超过该类型的体积上限；limit 是具体的字节数，UI 直接显示给用户。 */
export type TooLargeRead = {
  ok: true;
  kind: "tooLarge";
  path: string;
  size: number;
  mtimeMs: number;
  limit: number;
};

/** zip / apk / exe 这类没有可预览形态的文件。 */
export type BinaryRead = {
  ok: true;
  kind: "binary";
  path: string;
  size: number;
  mtimeMs: number;
};

/** 数据库头部读出来的概览（不含内容——真正的取数走 fm.sqlite.*，一次一页）。 */
export type SqliteInfo = {
  size: number;
  pageSize: number;
  pageCount: number;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  journalMode: "wal" | "rollback";
  schemaVersion: number;
  libraryVersion: number;
  /** 旁边有 -wal 文件：可能有还没合并回去的改动，显示的内容未必是最新。 */
  hasWal: boolean;
  hasJournal: boolean;
};

export type SqliteObject = {
  /** table | view | index | trigger */
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
};

export type SqliteColumn = {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
};

/** SQLite 文件：只带头部信息，字节留在主进程里。 */
export type SqliteRead = {
  ok: true;
  kind: "sqlite";
  path: string;
  size: number;
  mtimeMs: number;
  /** 宿主运行时有没有 node:sqlite；没有就只能看概览。 */
  available: boolean;
  info: SqliteInfo;
};

export type ReadResponse = TextRead | DataRead | TooLargeRead | BinaryRead | SqliteRead;

export type SqliteOpenResponse = {
  ok: true;
  path: string;
  info: SqliteInfo;
  objects: SqliteObject[];
};

export type SqliteRowsResponse = {
  ok: true;
  path: string;
  object: string;
  kind: "table" | "view";
  columns: SqliteColumn[];
  /** 单元格一律是字符串或 null（null 才是 SQL 的 NULL）。 */
  rows: (string | null)[][];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** max(rowid) 的估算，不是精确行数（精确 COUNT(*) 在大表上是全表扫描）。 */
  estimate: number | null;
  hasRowid: boolean;
};

export type SqliteQueryResponse = {
  ok: true;
  path: string;
  columns: SqliteColumn[];
  rows: (string | null)[][];
  truncated: boolean;
  elapsedMs: number;
};

export type SqliteRowsRequest = {
  path: string;
  object: string;
  page: number;
  pageSize: number;
  orderBy?: string;
  direction?: "asc" | "desc";
};

export type SqliteQueryRequest = { path: string; sql: string; limit: number };

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

export type ReadRequest = {
  path: string;
  /**
   * 宿主请求打开的项目之外绝对路径（会话临时目录 / 附件）：显式声明后主进程
   * 只查黑名单与 realpath，不再要求路径落在项目根内。
   */
  external?: boolean;
};

export type WriteRequest = {
  path: string;
  text: string;
  expectedMtimeMs: number;
  expectedSize: number;
  eol: "lf" | "crlf";
  bom: boolean;
  /** 同 ReadRequest.external：项目之外的绝对路径，主进程按外部路径解析。 */
  external?: boolean;
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
  sqliteOpen: "fm.sqlite.open",
  sqliteRows: "fm.sqlite.rows",
  sqliteQuery: "fm.sqlite.query",
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
    case "NOT_SQLITE":
      return t("sqliteNotADatabase");
    case "SQLITE_UNAVAILABLE":
      return t("sqliteUnavailable");
    case "SQLITE_BROKEN":
      return t("sqliteBroken");
    case "SQLITE_SQL_EMPTY":
      return t("sqliteSqlEmpty");
    case "SQLITE_SQL_TOO_LONG":
      return t("sqliteSqlTooLong");
    case "SQLITE_SQL_MULTIPLE":
      return t("sqliteSqlMultiple");
    case "SQLITE_SQL_NOT_READ_ONLY":
      return t("sqliteSqlReadOnly");
    case "SQLITE_NO_SUCH_OBJECT":
      return t("sqliteNoSuchObject");
    case "SQLITE_OFFSET_LIMIT":
      return t("sqliteOffsetLimit");
    default:
      // SQLITE_SQL_ERROR 走这里：引擎自己的报错（no such table: …）就是最有用的文案
      return failure.message || failure.code;
  }
}
