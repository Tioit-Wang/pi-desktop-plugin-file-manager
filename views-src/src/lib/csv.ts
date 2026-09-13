/**
 * 分隔符文本解析（CSV / TSV）。
 *
 * 手写而不是引库：规则本身很小（引号包裹、双引号转义、字段内换行、行内换行符），
 * 而本视图必须打成单个 IIFE 且离线可用，为这点逻辑加一个运行期依赖不划算。
 *
 * 换行统一按 LF 处理——主进程读文本时已经把 CRLF 归一过了，这里只需不把裸 CR
 * 当成内容（引号内的 CR 仍然保留）。
 */

/**
 * 解析上限：文件本身已被主进程限到 2 MiB，这里纯粹是内存的兜底阀门
 * （一行两个字符的极端文件能到上百万行）。
 */
export const MAX_PARSE_ROWS = 200000;
/** 列数上限：一次铺三万多个单元格已经够狠了，列再多就先省略。 */
export const MAX_TABLE_COLUMNS = 60;

/**
 * 每页行数。默认 1000：一次渲染一千行是「翻得动、也还看得清」的量级。
 * 上限 5000 是因为再往上（5000 行 × 60 列 = 三十万个节点）面板会明显卡顿。
 */
export const PAGE_SIZES = [100, 200, 500, 1000, 2000, 5000];
export const DEFAULT_PAGE_SIZE = 1000;

/**
 * 单元格：CSV 里是字符串，SQLite 里可能是 null（SQL 的 NULL）——排序、列宽、
 * 数字判定这些函数两种数据都要吃得下，所以统一放宽到 string | null。
 */
export type Cell = string | null;
export type Row = Cell[];

export type DelimitedTable = {
  rows: string[][];
  /** 解析行数达到上限，文件后面还有内容没解析。 */
  truncated: boolean;
};

export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number = MAX_PARSE_ROWS,
): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;

  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // "" 是字段内的一个引号；单个 " 结束引号段。
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    // 引号只在一个字段的开头才有语法意义，字段中间出现的 " 是普通字符。
    if (char === '"' && field === "") {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) {
      endRow();
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      continue;
    }

    if (char === "\r") continue; // CRLF 的 CR，由后面的 LF 收行

    field += char;
  }

  // 末行没有换行符结尾时补上；文件以换行结尾则不会多出一行空行。
  if (!truncated && (field !== "" || row.length > 0)) endRow();

  return { rows, truncated };
}

/** 表格实际渲染的列数：取最宽的一行，再套上限。 */
export function tableWidth(rows: Row[]): number {
  let width = 0;
  for (const row of rows) {
    if (row.length > width) width = row.length;
  }
  return Math.min(width, MAX_TABLE_COLUMNS);
}

export type PageBounds = {
  /** 夹紧之后的当前页（从 1 起）。页码越界时给的是最后一页，而不是空白。 */
  page: number;
  pageCount: number;
  /** 本页在数据行里的半开区间 [from, to)。 */
  from: number;
  to: number;
};

/**
 * 页码与切片区间。分页只影响渲染，不影响解析——整份文件一次解析完，
 * 每次只把当前页铺成节点，所以「1000 行一页」同时也是性能上限。
 */
export function pageBounds(totalRows: number, pageSize: number, page: number): PageBounds {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const total = Math.max(0, Math.floor(totalRows) || 0);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), pageCount);
  const from = (current - 1) * size;
  return { page: current, pageCount, from, to: Math.min(from + size, total) };
}

/** 数字形如 12、-3、4.5、1e6；带千分位或货币符号的不算，它们得按文本排。 */
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 一列全是数字、且至少有一个非空值。右对齐与排序共用这一条判据——这样
 * 右对齐的列按数值排（10 排在 2 后面），左对齐的列按文本排，两边不会打架。
 */
function isNumericColumn(rows: Row[], column: number): boolean {
  let seen = false;
  for (const row of rows) {
    const value = (row[column] ?? "").trim();
    if (!value) continue;
    if (!NUMBER.test(value)) return false;
    seen = true;
  }
  return seen;
}

export function numericColumns(rows: Row[], width: number): boolean[] {
  const flags: boolean[] = [];
  for (let column = 0; column < width; column += 1) flags.push(isNumericColumn(rows, column));
  return flags;
}

export type SortDirection = "asc" | "desc";
export type SortSpec = { column: number; direction: SortDirection };

/** 排序结果里的行：cells 是原样的一行，index 是它在文件里的数据行号（0 起）。 */
export type IndexedRow = { cells: Row; index: number };

/**
 * 自然序：file10 排在 file2 后面，大小写不敏感。只建一个 collator 实例——
 * 比较函数会被调用几十万次，每次 new 一个 Intl.Collator 会让大文件卡住。
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * 点击表头排序。spec 为 null 时就是原序，只把行号附上。
 *
 * 两条规则值得写下来：
 *  · **空值永远沉底**，升序降序都一样（表格软件的通行做法，不然一按降序，
 *    空行全飘到最前面）。
 *  · **整列都是数字才按数值比**，否则按文本比。混着比会出现「10 < 9」这种
 *    看不太懂的顺序。
 */
export function sortRows(rows: Row[], spec: SortSpec | null): IndexedRow[] {
  const indexed = rows.map((cells, index) => ({ cells, index }));
  if (!spec) return indexed;

  const column = spec.column;
  const direction = spec.direction === "asc" ? 1 : -1;
  const numeric = isNumericColumn(rows, column);

  // 排序键先算一遍（O(n)），别丢进 O(n log n) 的比较里反复 trim / parse。
  const prepared = indexed.map((item) => ({
    item,
    raw: (item.cells[column] ?? "").trim(),
    number: numeric ? Number((item.cells[column] ?? "").trim()) : 0,
  }));

  prepared.sort((left, right) => {
    const leftEmpty = left.raw === "";
    const rightEmpty = right.raw === "";
    if (leftEmpty || rightEmpty) {
      if (leftEmpty && rightEmpty) return 0;
      return leftEmpty ? 1 : -1;
    }
    if (numeric) return (left.number - right.number) * direction;
    return collator.compare(left.raw, right.raw) * direction;
  });

  return prepared.map((entry) => entry.item);
}
