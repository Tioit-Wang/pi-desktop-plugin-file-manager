/**
 * 变更内容（0.7.0）：把主进程解析好的 unified diff 渲染成带行号的对照视图。
 *
 * 这一层是纯展示：数据是 fm.git.diff 的响应（行类型 + 行号都由 main.js 算好），
 * 这里不再解析任何 diff 文本。段（scope）可能有多个——已暂存与未暂存都改了就
 * 两段都列出来，各自标清楚是哪一段。
 */

import type { T } from "../i18n";
import type { DiffSection, GitDiffResponse } from "../lib/rpc";
import { formatSize } from "../lib/format";

/** 差异视图的加载态。App 持有它，EditorPane 只负责摆出来。 */
export type DiffViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; response: Extract<GitDiffResponse, { ok: true }> };

type Props = {
  state: DiffViewState;
  t: T;
  onClose: () => void;
  onRefresh: () => void;
};

export function GitDiffView({ state, t, onClose, onRefresh }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--bg)" }}>
      <div
        className="flex flex-none items-center gap-2 border-b px-2.5 py-1.5 text-[11.5px]"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <span className="font-medium">{t("changes")}</span>
        {state.status === "ready" ? (
          <>
            <span className="tabular-nums" style={{ color: "var(--git-added)" }}>
              +{state.response.addedLines}
            </span>
            <span className="tabular-nums" style={{ color: "var(--git-deleted)" }}>
              −{state.response.deletedLines}
            </span>
            {state.response.untracked ? (
              <span style={{ color: "var(--muted)" }}>{t("gitUntracked")}</span>
            ) : null}
            {state.response.truncated ? (
              <span style={{ color: "var(--muted)" }}>{t("gitDiffTruncated")}</span>
            ) : null}
          </>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-1">
          <button
            type="button"
            title={t("refresh")}
            aria-label={t("refresh")}
            onClick={onRefresh}
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg border-0 bg-transparent transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: "var(--secondary)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
              <path d="M3 4v5h5" />
              <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
              <path d="M21 20v-5h-5" />
            </svg>
          </button>
          <button
            type="button"
            title={t("backToEditor")}
            aria-label={t("backToEditor")}
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg border-0 bg-transparent transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: "var(--secondary)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 19-7-7 7-7" />
              <path d="M19 12H5" />
            </svg>
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
            {t("loading")}
          </p>
        ) : null}

        {state.status === "error" ? (
          <p className="px-3 py-2 text-[11.5px]" role="alert" style={{ color: "var(--danger)" }}>
            {state.message}
          </p>
        ) : null}

        {state.status === "ready" ? <DiffBody response={state.response} t={t} /> : null}
      </div>
    </div>
  );
}

function DiffBody({ response, t }: { response: Extract<GitDiffResponse, { ok: true }>; t: T }) {
  if (response.kind === "none") {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitNoChanges")}
      </p>
    );
  }
  if (response.kind === "tooLarge") {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffTooLarge", {
          size: formatSize(response.size ?? 0),
          limit: formatSize(response.limit ?? 0),
        })}
      </p>
    );
  }
  if (response.kind === "binary" || response.sections.every((section) => section.binary)) {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffBinary")}
      </p>
    );
  }

  return (
    <>
      {response.sections.map((section, index) => (
        <DiffSectionView key={`${section.scope}:${index}`} section={section} t={t} />
      ))}
    </>
  );
}

function DiffSectionView({ section, t }: { section: DiffSection; t: T }) {
  if (section.binary) {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffBinary")}
      </p>
    );
  }
  return (
    <section className="border-b py-1" style={{ borderColor: "var(--border)" }}>
      <div
        className="sticky top-0 flex items-center gap-2 px-2.5 py-1 text-[10.5px]"
        style={{ background: "var(--surface)", color: "var(--muted)" }}
      >
        <span className="font-medium">
          {section.scope === "staged" ? t("gitScopeStaged") : t("gitScopeWorktree")}
        </span>
        {section.meta
          .filter((line) => line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("rename"))
          .map((line) => (
            <span key={line} className="truncate">
              {line}
            </span>
          ))}
        {section.truncated ? <span>{t("gitDiffTruncated")}</span> : null}
      </div>
      {section.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}:${hunkIndex}`} className="diff-hunk">
          <div className="diff-hunk-head" title={hunk.header}>
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`diff-line diff-line-${line.type}`}>
              <span className="diff-num">{line.oldLine ?? ""}</span>
              <span className="diff-num">{line.newLine ?? ""}</span>
              <span className="diff-sign" aria-hidden="true">
                {line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "note" ? "\\" : " "}
              </span>
              <span className="diff-text">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
