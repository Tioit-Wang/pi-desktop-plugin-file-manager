import { useMemo } from "react";
import { PAGE_SIZES, type Cell, type SortSpec } from "../lib/csv";
import type { T } from "../i18n";

export type DataColumn = {
  label: string;
  /** 表头悬停提示：完整列名 + 类型/约束。 */
  title?: string;
  /** 右对齐（CSV 按当前页内容判定，SQLite 直接看 schema 类型）。 */
  numeric?: boolean;
};

export type DataRow = {
  key: string | number;
  /** 最左行号列显示的值。 */
  index: number;
  cells: Cell[];
};

type Props = {
  columns: DataColumn[];
  rows: DataRow[];
  showIndex?: boolean;
  sort: SortSpec | null;
  onSort: (column: number) => void;
  /** 底部左侧的范围文案，由调用方决定措辞（CSV 是「第几到第几行」，SQLite 是「大概几行」）。 */
  range: string;
  notes?: string[];
  page: number;
  /** null = 服务端分页、总数未知：只显示当前页，末页按钮禁用。 */
  pageCount: number | null;
  onPage: (page: number) => void;
  pageSize: number;
  onPageSize: (size: number) => void;
  busy?: boolean;
  t: T;
};

/**
 * 表格外壳：吸顶表头、吸左行号、点表头排序、底部翻页条、斑马纹、数字右对齐。
 *
 * 只负责「画」——分页与排序的数据从哪来由调用方决定：
 * CSV 在内存里切片，SQLite 把页码与排序列翻译成 SQL 让主进程出数据。
 * 两边共用这一个组件，才不会出现「CSV 有的行为 SQLite 没有」的漂移。
 */
export function DataTable({
  columns,
  rows,
  showIndex = true,
  sort,
  onSort,
  range,
  notes = [],
  page,
  pageCount,
  onPage,
  pageSize,
  onPageSize,
  busy,
  t,
}: Props) {
  // 偏好里可能存着一个不在候选里的值（手工改过设置），那就把它也列进去，
  // 不然下拉框会显示成空白。
  const sizes = useMemo(
    () =>
      PAGE_SIZES.includes(pageSize) ? PAGE_SIZES : [...PAGE_SIZES, pageSize].sort((a, b) => a - b),
    [pageSize],
  );

  const hasNext = pageCount === null ? true : page < pageCount;
  const hasPrev = page > 1;

  return (
    <div className="dt-view" data-busy={busy ? "true" : undefined}>
      <div className="dt-scroll">
        <table className="dt-table">
          <thead>
            <tr>
              {showIndex ? <th className="dt-index" scope="col" /> : null}
              {columns.map((column, index) => {
                const active = sort?.column === index;
                const direction = active && sort ? sort.direction : null;
                return (
                  <th
                    key={index}
                    scope="col"
                    className="dt-sortable"
                    aria-sort={
                      direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"
                    }
                  >
                    <button
                      type="button"
                      className="dt-sort"
                      data-active={active ? "true" : undefined}
                      // 提示的是「点下去会发生什么」，不是当前状态
                      title={
                        direction === "asc"
                          ? t("sortDesc")
                          : direction === "desc"
                            ? t("sortClear")
                            : t("sortAsc")
                      }
                      onClick={() => onSort(index)}
                    >
                      <span className="dt-head" title={column.title ?? column.label}>
                        {column.label}
                      </span>
                      <span className="dt-arrow" aria-hidden="true">
                        {direction === "asc" ? "▲" : direction === "desc" ? "▼" : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {showIndex ? <td className="dt-index">{row.index}</td> : null}
                {columns.map((column, columnIndex) => {
                  const value = row.cells[columnIndex] ?? null;
                  return (
                    <td
                      key={columnIndex}
                      // 单元格会被省略号截断，悬停才看得到全值
                      title={value ?? undefined}
                      data-numeric={column.numeric ? "true" : undefined}
                    >
                      {value === null ? <span className="dt-null">NULL</span> : value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dt-bar">
        <span className="dt-range">{range}</span>
        {notes.map((note) => (
          <span className="dt-warn" key={note}>
            {note}
          </span>
        ))}

        <div className="dt-pager">
          <PageButton label={t("firstPage")} glyph="«" disabled={!hasPrev} onClick={() => onPage(1)} />
          <PageButton
            label={t("prevPage")}
            glyph="‹"
            disabled={!hasPrev}
            onClick={() => onPage(page - 1)}
          />
          <span className="dt-page">
            {pageCount === null
              ? t("pageOnly", { page })
              : t("pageOf", { page, count: pageCount })}
          </span>
          <PageButton
            label={t("nextPage")}
            glyph="›"
            disabled={!hasNext}
            onClick={() => onPage(page + 1)}
          />
          <PageButton
            label={t("lastPage")}
            glyph="»"
            disabled={pageCount === null || page >= pageCount}
            onClick={() => pageCount !== null && onPage(pageCount)}
          />
        </div>

        <label className="dt-size">
          {t("pageSize")}
          <select
            value={pageSize}
            aria-label={t("pageSize")}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {sizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function PageButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {glyph}
    </button>
  );
}
