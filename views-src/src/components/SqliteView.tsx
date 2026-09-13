import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../lib/bridge";
import {
  channels,
  failureMessage,
  type Failure,
  type SqliteInfo,
  type SqliteOpenResponse,
  type SqliteQueryResponse,
  type SqliteRowsResponse,
} from "../lib/rpc";
import { numericColumns, pageBounds, sortRows, type SortSpec } from "../lib/csv";
import { formatSize } from "../lib/format";
import type { T } from "../i18n";
import { DataTable, type DataColumn, type DataRow } from "./DataTable";

type Props = {
  path: string;
  info: SqliteInfo;
  /** 宿主运行时有没有 node:sqlite。 */
  available: boolean;
  pageSize: number;
  onPageSize: (size: number) => void;
  t: T;
};

const QUERY_LIMITS = [100, 500, 1000, 5000];

/** 头部的库版本号是 3045003 这种形式。 */
function versionOf(value: number): string {
  return `${Math.floor(value / 1000000)}.${Math.floor((value % 1000000) / 1000)}.${value % 1000}`;
}

/**
 * SQLite 查看器：概览 + 对象浏览 + 结构 + 只读 SQL 查询。
 *
 * 所有取数都在主进程里完成，一次只回来一页——数据库文件不会进到这个页面里，
 * 所以这里的行数与排序都要下推给服务端（翻页改页码、点表头改 orderBy），
 * 只有 SQL 结果例外：它已经被行数上限截断，在本地翻页与排序就够了。
 */
export function SqliteView({ path, info, available, pageSize, onPageSize, t }: Props) {
  const [schema, setSchema] = useState<SqliteOpenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"browse" | "sql">("browse");

  const [object, setObject] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [structure, setStructure] = useState(false);
  const [rows, setRows] = useState<SqliteRowsResponse | null>(null);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const [sql, setSql] = useState("select * from ");
  const [limit, setLimit] = useState(500);
  const [result, setResult] = useState<SqliteQueryResponse | null>(null);
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [resultPage, setResultPage] = useState(1);
  const [resultSort, setResultSort] = useState<SortSpec | null>(null);

  // 取数用到的列名要用于 orderBy，但把它放进依赖会让「取回数据 → 依赖变化 → 再取」
  // 变成死循环，所以走 ref。
  const columnsRef = useRef<SqliteRowsResponse["columns"]>([]);
  columnsRef.current = rows?.columns ?? [];

  const schemaTokenRef = useRef(0);
  const rowsTokenRef = useRef(0);

  // ── 打开库（读 schema） ──────────────────────────────────────────────────

  useEffect(() => {
    const token = ++schemaTokenRef.current;
    setSchema(null);
    setError(null);
    setRows(null);
    setRowsError(null);
    setPage(1);
    setSort(null);
    if (!available) return;

    void (async () => {
      try {
        const response = await invoke<SqliteOpenResponse | Failure>(channels.sqliteOpen, { path });
        if (token !== schemaTokenRef.current) return;
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        setSchema(response);
        const first =
          response.objects.find((entry) => entry.type === "table") ??
          response.objects.find((entry) => entry.type === "view");
        setObject(first ? first.name : "");
      } catch (cause) {
        if (token !== schemaTokenRef.current) return;
        setError(String((cause as Error).message));
      }
    })();
  }, [path, available, t]);

  // ── 取一页数据 ───────────────────────────────────────────────────────────

  const loadRows = useCallback(
    async (target: string, targetPage: number, targetSort: SortSpec | null) => {
      const token = ++rowsTokenRef.current;
      const column = targetSort ? columnsRef.current[targetSort.column] : undefined;
      setRowsBusy(true);
      setRowsError(null);
      try {
        const response = await invoke<SqliteRowsResponse | Failure>(channels.sqliteRows, {
          path,
          object: target,
          page: targetPage,
          pageSize,
          orderBy: column ? column.name : undefined,
          direction: targetSort ? targetSort.direction : undefined,
        });
        if (token !== rowsTokenRef.current) return;
        if (!response.ok) {
          setRowsError(failureMessage(response, t));
          setRows(null);
          return;
        }
        setRows(response);
      } catch (cause) {
        if (token !== rowsTokenRef.current) return;
        setRowsError(String((cause as Error).message));
      } finally {
        if (token === rowsTokenRef.current) setRowsBusy(false);
      }
    },
    [path, pageSize, t],
  );

  // 「有没有数据」用 ref 判断：把它写进依赖会让「取回数据 → 依赖变化 → 再取」死循环
  const hasRowsRef = useRef(false);
  hasRowsRef.current = Boolean(rows);

  useEffect(() => {
    if (tab !== "browse" || !object) return;
    // 结构面板只是在已有的列信息上换个呈现，没必要再取一页
    if (structure && hasRowsRef.current) return;
    void loadRows(object, page, sort);
  }, [tab, structure, object, page, sort, loadRows]);

  /** 换对象：页码与排序都归零。 */
  const pickObject = (name: string) => {
    setObject(name);
    setPage(1);
    setSort(null);
    setStructure(false);
  };

  const toggleSort = (column: number) => {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null;
    });
    setPage(1);
  };

  // ── 自定义 SQL ───────────────────────────────────────────────────────────

  const runQuery = useCallback(async () => {
    const statement = sql.trim();
    if (!statement) {
      setQueryError(t("sqliteSqlEmpty"));
      setResult(null);
      return;
    }
    setQueryBusy(true);
    setQueryError(null);
    try {
      const response = await invoke<SqliteQueryResponse | Failure>(channels.sqliteQuery, {
        path,
        sql: statement,
        limit,
      });
      if (!response.ok) {
        setQueryError(failureMessage(response, t));
        setResult(null);
        return;
      }
      setResult(response);
      setResultPage(1);
      setResultSort(null);
    } catch (cause) {
      setQueryError(String((cause as Error).message));
      setResult(null);
    } finally {
      setQueryBusy(false);
    }
  }, [path, sql, limit, t]);

  // ── 渲染数据 ─────────────────────────────────────────────────────────────

  const browseColumns: DataColumn[] = useMemo(() => {
    const columns = rows?.columns ?? [];
    const numeric = numericColumns(rows?.rows ?? [], columns.length);
    return columns.map((column, index) => ({
      label: column.name,
      numeric: numeric[index],
      title: [column.name, column.type || "?", column.pk ? "PK" : "", column.notNull ? "NOT NULL" : ""]
        .filter(Boolean)
        .join(" · "),
    }));
  }, [rows]);

  const pageOffset = rows ? (rows.page - 1) * rows.pageSize : 0;

  const browseRows: DataRow[] = (rows?.rows ?? []).map((cells, index) => ({
    key: pageOffset + index,
    index: pageOffset + index + 1,
    cells,
  }));

  const browseRange = useMemo(() => {
    if (!rows) return "";
    if (rows.rows.length === 0) return t("tableRows", { count: 0 });
    return `${pageOffset + 1}–${pageOffset + rows.rows.length}`;
  }, [rows, pageOffset, t]);

  const browseNotes: string[] = [];
  if (rows?.estimate !== null && rows?.estimate !== undefined) {
    browseNotes.push(t("sqliteEstimate", { count: rows.estimate }));
  }

  const orderedResults = useMemo(() => sortRows(result?.rows ?? [], resultSort), [result, resultSort]);
  const resultBounds = pageBounds(orderedResults.length, pageSize, resultPage);
  const resultPageRows = useMemo(
    () => orderedResults.slice(resultBounds.from, resultBounds.to),
    [orderedResults, resultBounds.from, resultBounds.to],
  );

  const resultColumns: DataColumn[] = useMemo(() => {
    const columns = result?.columns ?? [];
    const numeric = numericColumns(
      resultPageRows.map((item) => item.cells),
      columns.length,
    );
    return columns.map((column, index) => ({
      label: column.name,
      numeric: numeric[index],
      title: column.type ? `${column.name} · ${column.type}` : column.name,
    }));
  }, [result, resultPageRows]);

  const objects = schema?.objects ?? [];
  const tables = objects.filter((entry) => entry.type === "table");
  const views = objects.filter((entry) => entry.type === "view");
  const current = objects.find((entry) => entry.name === object) ?? null;
  const indexes = objects.filter((entry) => entry.type === "index" && entry.tableName === object);
  const triggers = objects.filter((entry) => entry.type === "trigger" && entry.tableName === object);

  return (
    <div className="sq-view">
      <div className="sq-info">
        <span className="sq-name" title={path}>
          {path.slice(path.lastIndexOf("/") + 1)}
        </span>
        <span>{formatSize(info.size)}</span>
        <span>
          {info.pageSize} B × {info.pageCount}
        </span>
        <span>{info.encoding}</span>
        <span>SQLite {versionOf(info.libraryVersion)}</span>
        <span className="sq-badge">{t("readOnly")}</span>
      </div>

      {info.journalMode === "wal" || info.hasWal ? (
        <div className="sq-warn">{t("sqliteWalWarning")}</div>
      ) : null}

      {!available ? (
        <div className="sq-notice">{t("sqliteUnavailable")}</div>
      ) : (
        <>
          <div className="sq-tabs" role="tablist" aria-label={t("title")}>
            {(["browse", "sql"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={tab === candidate}
                data-active={tab === candidate ? "true" : undefined}
                className="sq-tab"
                onClick={() => setTab(candidate)}
              >
                {candidate === "browse" ? t("sqliteTabBrowse") : t("sqliteTabSql")}
              </button>
            ))}
          </div>

          {error ? <div className="sq-notice sq-danger">{error}</div> : null}

          {tab === "browse" && !error ? (
            <>
              <div className="sq-bar">
                {tables.length + views.length === 0 ? (
                  <span className="sq-hint">{t("sqliteNoTables")}</span>
                ) : (
                  <select
                    className="sq-select"
                    aria-label={t("sqliteObject")}
                    value={object}
                    onChange={(event) => pickObject(event.target.value)}
                  >
                    {tables.length > 0 ? (
                      <optgroup label={t("sqliteTablesGroup")}>
                        {tables.map((entry) => (
                          <option key={entry.name} value={entry.name}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {views.length > 0 ? (
                      <optgroup label={t("sqliteViewsGroup")}>
                        {views.map((entry) => (
                          <option key={entry.name} value={entry.name}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                )}

                <button
                  type="button"
                  className="sq-toggle"
                  data-active={structure ? "true" : undefined}
                  onClick={() => setStructure((value) => !value)}
                  disabled={!object}
                >
                  {t("sqliteStructure")}
                </button>

                <button
                  type="button"
                  className="sq-toggle"
                  disabled={!object}
                  onClick={() => {
                    setSql(`select * from "${object.split('"').join('""')}" limit 100`);
                    setTab("sql");
                  }}
                >
                  {t("sqliteQueryThis")}
                </button>
              </div>

              {rowsError ? <div className="sq-notice sq-danger">{rowsError}</div> : null}

              {structure ? (
                <div className="sq-structure">
                  <div className="sq-struct-title">{t("sqliteColumns")}</div>
                  <ul className="sq-struct-list">
                    {(rows?.columns ?? []).map((column) => (
                      <li key={column.name}>
                        <span className="sq-col-name">{column.name}</span>
                        <span className="sq-col-type">{column.type || "?"}</span>
                        {column.pk ? <span className="sq-flag">PK</span> : null}
                        {column.notNull ? <span className="sq-flag">NOT NULL</span> : null}
                      </li>
                    ))}
                  </ul>

                  {indexes.length > 0 ? (
                    <>
                      <div className="sq-struct-title">{t("sqliteIndexes")}</div>
                      <ul className="sq-struct-list">
                        {indexes.map((entry) => (
                          <li key={entry.name} title={entry.sql ?? ""}>
                            <span className="sq-col-name">{entry.name}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {triggers.length > 0 ? (
                    <>
                      <div className="sq-struct-title">{t("sqliteTriggers")}</div>
                      <ul className="sq-struct-list">
                        {triggers.map((entry) => (
                          <li key={entry.name} title={entry.sql ?? ""}>
                            <span className="sq-col-name">{entry.name}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {current?.sql ? (
                    <>
                      <div className="sq-struct-title">SQL</div>
                      <pre className="sq-sql">{current.sql}</pre>
                    </>
                  ) : null}
                </div>
              ) : rows ? (
                <DataTable
                  columns={browseColumns}
                  rows={browseRows}
                  showIndex={!rows.hasRowid}
                  sort={sort}
                  onSort={toggleSort}
                  range={browseRange}
                  notes={browseNotes}
                  page={rows.page}
                  // 不知道总页数时只显示当前页；已经翻到底就把末页锁上
                  pageCount={rows.hasMore ? null : rows.page}
                  onPage={setPage}
                  pageSize={pageSize}
                  onPageSize={onPageSize}
                  busy={rowsBusy}
                  t={t}
                />
              ) : (
                <div className="sq-notice">{rowsBusy ? t("loading") : t("sqliteNoTables")}</div>
              )}
            </>
          ) : null}

          {tab === "sql" ? (
            <>
              <div className="sq-bar">
                <button type="button" className="sq-run" onClick={() => void runQuery()} disabled={queryBusy}>
                  {queryBusy ? t("loading") : t("sqliteRun")}
                </button>
                <span className="sq-hint">{t("sqliteRunHint")}</span>
                <label className="sq-size">
                  {t("sqliteLimit")}
                  <select
                    value={limit}
                    aria-label={t("sqliteLimit")}
                    onChange={(event) => setLimit(Number(event.target.value))}
                  >
                    {QUERY_LIMITS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <textarea
                className="sq-editor"
                spellCheck={false}
                value={sql}
                placeholder="select * from …"
                onChange={(event) => setSql(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void runQuery();
                  }
                }}
              />

              {queryError ? <div className="sq-notice sq-danger">{queryError}</div> : null}

              {result ? (
                <div className="sq-result">
                  <div className="sq-result-meta">
                    <span>{t("sqliteRowsReturned", { count: result.rows.length, ms: result.elapsedMs })}</span>
                    {result.truncated ? <span className="sq-danger">{t("sqliteTruncated")}</span> : null}
                  </div>
                  <DataTable
                    columns={resultColumns}
                    rows={resultPageRows.map((item) => ({
                      key: item.index,
                      index: item.index + 1,
                      cells: item.cells,
                    }))}
                    sort={resultSort}
                    onSort={(column) =>
                      setResultSort((prev) => {
                        if (!prev || prev.column !== column) return { column, direction: "asc" };
                        if (prev.direction === "asc") return { column, direction: "desc" };
                        return null;
                      })
                    }
                    range={
                      orderedResults.length === 0
                        ? t("tableRows", { count: 0 })
                        : t("rowsRange", {
                            from: resultBounds.from + 1,
                            to: resultBounds.to,
                            total: orderedResults.length,
                          })
                    }
                    page={resultBounds.page}
                    pageCount={resultBounds.pageCount}
                    onPage={setResultPage}
                    pageSize={pageSize}
                    onPageSize={onPageSize}
                    t={t}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
