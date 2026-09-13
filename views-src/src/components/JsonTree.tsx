import { useMemo, useState } from "react";
import { parseJson } from "../lib/json";
import type { T } from "../i18n";

type Props = {
  text: string;
  t: T;
};

/** 单个节点默认展开的深度；再深就要手点，免得一打开就把大文件铺满。 */
const AUTO_OPEN_DEPTH = 2;
/** 一个节点最多直接渲染多少个子项，其余折叠到按钮后面。 */
const CHILD_LIMIT = 100;
/** 超长字符串只显示开头，完整值放 title。 */
const STRING_LIMIT = 160;

const indent = (depth: number) => 8 + depth * 14;

export function JsonTree({ text, t }: Props) {
  const parsed = useMemo(() => parseJson(text), [text]);

  return (
    <div className="json-scroll">
      {parsed.ok ? (
        <div className="json-body">
          <JsonNode value={parsed.value} depth={0} t={t} />
        </div>
      ) : (
        <div className="json-error">{t("jsonInvalid", { message: parsed.message })}</div>
      )}
    </div>
  );
}

function JsonNode({
  value,
  label,
  depth,
  t,
}: {
  value: unknown;
  label?: string;
  depth: number;
  t: T;
}) {
  if (typeof value === "object" && value !== null) {
    return <JsonBranch value={value} label={label} depth={depth} t={t} />;
  }

  return (
    <div className="json-row" style={{ paddingLeft: indent(depth) }}>
      <span className="json-caret" />
      {label === undefined ? null : <span className="json-key">{label}</span>}
      <JsonLeaf value={value} />
    </div>
  );
}

function JsonBranch({
  value,
  label,
  depth,
  t,
}: {
  value: object;
  label?: string;
  depth: number;
  t: T;
}) {
  const entries = useMemo<[string, unknown][]>(
    () =>
      Array.isArray(value)
        ? value.map((item, index) => [String(index), item] as [string, unknown])
        : Object.entries(value),
    [value],
  );

  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH);
  const [showAll, setShowAll] = useState(false);

  const isArray = Array.isArray(value);
  const shown = showAll ? entries : entries.slice(0, CHILD_LIMIT);

  return (
    <>
      <button
        type="button"
        className="json-row json-summary"
        style={{ paddingLeft: indent(depth) }}
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="json-caret">{open ? "▾" : "▸"}</span>
        {label === undefined ? null : <span className="json-key">{label}</span>}
        <span className="json-brace">{isArray ? "[" : "{"}</span>
        <span className="json-count">{t("jsonItems", { count: entries.length })}</span>
        <span className="json-brace">{isArray ? "]" : "}"}</span>
      </button>

      {open ? (
        <>
          {shown.map(([key, child]) => (
            <JsonNode key={key} value={child} label={key} depth={depth + 1} t={t} />
          ))}
          {shown.length < entries.length ? (
            <button
              type="button"
              className="json-more"
              style={{ paddingLeft: indent(depth + 1) }}
              onClick={() => setShowAll(true)}
            >
              {t("jsonMore", { count: entries.length - shown.length })}
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function JsonLeaf({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>;

  if (typeof value === "string") {
    const clipped = value.length > STRING_LIMIT;
    return (
      <span className="json-string" title={clipped ? value : undefined}>
        "{clipped ? `${value.slice(0, STRING_LIMIT)}…` : value}"
      </span>
    );
  }

  if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
  return <span className="json-null">{String(value)}</span>;
}
