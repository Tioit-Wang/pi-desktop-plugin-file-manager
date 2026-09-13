import { useEffect, useMemo, useState } from "react";
import {
  MAX_PARSE_ROWS,
  MAX_TABLE_COLUMNS,
  numericColumns,
  pageBounds,
  parseDelimited,
  sortRows,
  tableWidth,
  type SortSpec,
} from "../lib/csv";
import type { T } from "../i18n";
import { DataTable, type DataColumn, type DataRow } from "./DataTable";

type Props = {
  text: string;
  delimiter: string;
  /** 每页行数（偏好里记着，见 main.js 的 tablePageSize）。 */
  pageSize: number;
  onPageSize: (size: number) => void;
  t: T;
};

/**
 * 分隔符文本的表格视图。
 *
 * 首行当表头，其余分页渲染：整份文件一次解析完，但每次只把当前页铺成节点——
 * 一千行 × 六十列已经是三万个单元格，再多面板就要卡。分页在这里同时是
 * 「看得下去」和「跑得动」两件事的解法。
 */
export function CsvTable({ text, delimiter, pageSize, onPageSize, t }: Props) {
  const { rows, truncated } = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortSpec | null>(null);

  // 换文件、换分隔符、改每页行数、改排序都回到第一页：停在「第 7 页」却换了份
  // 只有两页的文件，只会让人对着空白发愣。
  useEffect(() => {
    setPage(1);
  }, [text, delimiter, pageSize, sort]);

  const header = rows[0];
  const body = useMemo(() => rows.slice(1), [rows]);

  const { columns, hiddenColumns } = useMemo(() => {
    const width = tableWidth(rows);
    const hidden =
      width < MAX_TABLE_COLUMNS
        ? 0
        : rows.reduce((max, row) => Math.max(max, row.length), 0) - MAX_TABLE_COLUMNS;
    return { columns: width, hiddenColumns: hidden };
  }, [rows]);

  const ordered = useMemo(() => sortRows(body, sort), [body, sort]);
  const bounds = pageBounds(ordered.length, pageSize, page);
  const pageRows = useMemo(
    () => ordered.slice(bounds.from, bounds.to),
    [ordered, bounds.from, bounds.to],
  );
  const numeric = useMemo(
    () => numericColumns(pageRows.map((item) => item.cells), columns),
    [pageRows, columns],
  );

  /** 点表头：升序 → 降序 → 回到文件原序。 */
  const toggleSort = (column: number) => {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  };

  if (rows.length === 0) {
    return <div className="dt-empty">{t("tableEmpty")}</div>;
  }

  const dataColumns: DataColumn[] = Array.from({ length: columns }, (_, index) => ({
    label: header[index] ?? "",
    numeric: numeric[index],
  }));

  const dataRows: DataRow[] = pageRows.map((item) => ({
    key: item.index,
    index: item.index + 1,
    cells: item.cells.slice(0, columns),
  }));

  const notes: string[] = [];
  if (truncated) notes.push(t("tableParseLimit", { count: MAX_PARSE_ROWS }));
  if (hiddenColumns > 0) notes.push(t("tableColumns", { count: hiddenColumns }));

  return (
    <DataTable
      columns={dataColumns}
      rows={dataRows}
      sort={sort}
      onSort={toggleSort}
      range={
        ordered.length === 0
          ? t("tableRows", { count: 0 })
          : t("rowsRange", { from: bounds.from + 1, to: bounds.to, total: ordered.length })
      }
      notes={notes}
      page={bounds.page}
      pageCount={bounds.pageCount}
      onPage={setPage}
      pageSize={pageSize}
      onPageSize={onPageSize}
      t={t}
    />
  );
}
