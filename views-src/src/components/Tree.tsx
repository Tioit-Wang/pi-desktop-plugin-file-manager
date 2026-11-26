import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../lib/rpc";
import { FileIcon } from "../lib/fileIcons";
import { Skeleton } from './Skeleton';
import { formatSize } from "../lib/format";
import type { T } from "../i18n";
import { gitColor, gitGlyph, gitTitle } from "../lib/git";
import { canMoveTo, movableEntry } from "../lib/tree-move";

const DRAG_TYPE = "application/x-pi-file-manager-tree-move";
const dropOutline = { outline: "2px solid var(--accent)", outlineOffset: -2 };

export type DirState = {
  loading?: boolean;
  entries?: FileEntry[];
  error?: string;
};

type Props = {
  directories: Map<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  showIgnored: boolean;
  /** Name filter for the already-loaded part of the tree (empty = no filter). */
  filter?: string;
  t: T;
  onToggle: (path: string) => void;
  onOpen: (entry: FileEntry) => void;
  onRefreshDir: (path: string) => void;
  onMove?: (entry: FileEntry, targetDirectory: string) => void;
  onComposerFileDrag?: (entry: FileEntry) => boolean;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry | null) => void;
};

type Row =
  | { kind: "note"; path: string; depth: number; text: string; error: boolean }
  | { kind: "entry"; path: string; depth: number; entry: FileEntry };

/**
 * 把「已展开的目录链」摊平成一维行列表再渲染。
 * 树是懒加载的，屏幕内容完全由 directories + expanded 决定；摊平之后
 * 键盘导航只需要处理一个数组，比在 DOM 里上上下下简单得多。
 */
function buildRows(
  dirPath: string,
  depth: number,
  directories: Map<string, DirState>,
  expanded: Set<string>,
  showIgnored: boolean,
  t: T,
  /**
   * 已经小写的筛选词；空串表示不过滤。筛选是**纯展示**：它只挑出名字命中
   * 的条目，不改变展开状态、也不加载任何目录——所以清空筛选后树还是原来的
   * 样子。未展开目录的子树里有没有命中，这里无从知道（树是懒加载的），
   * 因此筛选时只认已经加载并展开的那部分，与「整个项目搜索」是两个入口。
   */
  filter: string,
): Row[] {
  const state = directories.get(dirPath);
  if (state?.error) {
    return [{ kind: "note", path: dirPath, depth, text: state.error, error: true }];
  }
  if (!state || !state.entries) {
    return [{ kind: "note", path: dirPath, depth, text: t("loading"), error: false }];
  }

  let entries = showIgnored
    ? state.entries
    : state.entries.filter((entry) => !entry.ignored);
  if (filter) entries = entries.filter((entry) => entry.name.toLowerCase().includes(filter));

  if (entries.length === 0) {
    // 筛选筛空不等于「这个文件夹是空的」：说清楚是哪一种，免得用户以为目录真的没了。
    const text = filter && state.entries.length > 0 ? t("filterEmpty") : t("empty");
    return [{ kind: "note", path: dirPath, depth, text, error: false }];
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    rows.push({ kind: "entry", path: entry.path, depth, entry });
    if (entry.isDirectory && expanded.has(entry.path)) {
      rows.push(...buildRows(entry.path, depth + 1, directories, expanded, showIgnored, t, filter));
    }
  }
  return rows;
}

export function Tree({
  directories,
  expanded,
  selected,
  showIgnored,
  filter = "",
  t,
  onToggle,
  onOpen,
  onRefreshDir,
  onMove,
  onComposerFileDrag,
  onContextMenu,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const needle = filter.trim().toLowerCase();
  const rows = useMemo(
    () => buildRows("", 0, directories, expanded, showIgnored, t, needle),
    [directories, expanded, showIgnored, t, needle],
  );
  const [drag, setDrag] = useState<{ entry: FileEntry; rows: Row[]; token: string } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // A refresh/root switch changes the rows snapshot, even for identically named files.
  const activeDrag = onMove && drag?.rows === rows ? drag : null;
  useEffect(() => {
    if (drag && !activeDrag) { setDrag(null); setHighlight(null); }
  }, [drag, activeDrag]);

  const finishDrag = () => { setDrag(null); setHighlight(null); };
  const destination = (event: React.DragEvent<HTMLDivElement>): string | null => {
    if (!activeDrag || !event.dataTransfer.types.includes(DRAG_TYPE)) return null;
    const node = event.target as Element;
    const rowIndex = node.closest<HTMLElement>("[data-row-index]")?.dataset.rowIndex;
    const row = rowIndex === undefined ? null : rows[Number(rowIndex)];
    const atRoot = node === event.currentTarget || !!node.closest("[data-root-drop]");
    if (!atRoot && row?.kind !== "entry") return null;
    const target = row?.kind === "entry" ? row.entry : null;
    return canMoveTo(activeDrag.entry, target) ? target?.path ?? "" : null;
  };

  // 选中项滚入视野——搜索跳转之后需要它。
  useEffect(() => {
    if (!selected) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${clamped}"]`)
      ?.focus();
  };

  const activate = (row: Row) => {
    if (row.kind !== "entry") {
      if (row.error) onRefreshDir(row.path);
      return;
    }
    if (row.entry.isDirectory) onToggle(row.entry.path);
    else onOpen(row.entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number, row: Row) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusRow(0);
        return;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(row);
        return;
      case "ArrowRight":
        if (row.kind === "entry" && row.entry.isDirectory && !expanded.has(row.entry.path)) {
          event.preventDefault();
          onToggle(row.entry.path);
        }
        return;
      case "ArrowLeft":
        if (row.kind === "entry" && row.entry.isDirectory && expanded.has(row.entry.path)) {
          event.preventDefault();
          onToggle(row.entry.path);
        }
        return;
      default:
    }
  };

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label={t("treeSection")}
      aria-busy={!directories.has("") || directories.get("")?.loading === true}
      className="min-h-0 flex-1 overflow-auto px-1.5 pb-4"
      onDragOver={(event) => {
        event.preventDefault(); // Also prevent native file/URL navigation for foreign payloads.
        const path = destination(event);
        event.dataTransfer.dropEffect = path === null ? "none" : "move";
        setHighlight(path);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHighlight(null);
      }}
      onDragEnd={finishDrag}
      onDrop={(event) => {
        event.preventDefault();
        const path = destination(event);
        finishDrag();
        // Never read paths from dataTransfer. Only this particular drag may consume the in-memory entry.
        if (activeDrag && path !== null && event.dataTransfer.getData(DRAG_TYPE) === activeDrag.token) {
          onMove?.(activeDrag.entry, path);
        }
      }}
      onContextMenu={(event) => {
        // 空白处右键：不带条目，菜单只提供「在此新建」与刷新。
        if ((event.target as HTMLElement).closest(".tree-row")) return;
        event.preventDefault();
        onContextMenu(event, null);
      }}
    >
      {rows.map((row, index) => {
        if (row.kind === "note") {
          if (!row.error && row.text === t('loading')) return <div key={`loading:${row.path}`} style={{ paddingLeft: row.depth * 14 }}><Skeleton kind="list" compact={row.depth > 0} label={t('loading')} /></div>;
          return (
            <div
              key={`note:${row.path}:${row.text}`}
              className="flex min-h-[24px] items-center gap-1.5 py-0.5 pr-2 text-[11.5px]"
              style={{
                paddingLeft: 12 + row.depth * 14,
                color: row.error ? "var(--danger)" : "var(--muted)",
              }}
            >
              <span className="min-w-0">{row.text}</span>
              {row.error ? (
                <button
                  type="button"
                  className="ml-auto border-0 bg-transparent p-0 underline underline-offset-2"
                  style={{ color: "var(--secondary)" }}
                  onClick={() => onRefreshDir(row.path)}
                >
                  {t("retry")}
                </button>
              ) : null}
            </div>
          );
        }

        const { entry } = row;
        const isSelected = selected === entry.path;
        const isExpanded = expanded.has(entry.path);
        const dimmed = entry.ignored && showIgnored;
        const canMove = !!onMove && movableEntry(entry);
        const canReference = !!onComposerFileDrag && !entry.isDirectory && !entry.isSymlink && !entry.outside;

        return (
          <button
            key={entry.path}
            type="button"
            data-path={entry.path}
            data-row-index={index}
            data-selected={isSelected ? "true" : undefined}
            data-ignored={dimmed ? "true" : undefined}
            role="treeitem"
            aria-expanded={entry.isDirectory ? isExpanded : undefined}
            aria-selected={isSelected}
            aria-level={row.depth + 1}
            // tooltip 把状态讲全：徽标只有一个字母，鼠标停上去才知道是未跟踪还是已暂存。
            title={[
              entry.path,
              entry.outside ? t("symlinkOutside") : entry.ignored ? t("ignoredBadge") : null,
              entry.git ? gitTitle(entry.git, t) : null,
            ]
              .filter(Boolean)
              .join(" — ")}
            disabled={entry.isSymlink}
            draggable={canMove || canReference}
            onDragStart={(event) => {
              const reference = canReference && onComposerFileDrag?.(entry);
              if (canMove) {
                const token = crypto.randomUUID();
                event.dataTransfer.effectAllowed = reference ? "copyMove" : "move";
                event.dataTransfer.setData(DRAG_TYPE, token);
                setHighlight(null);
                setDrag({ entry, rows, token });
              } else if (reference) {
                event.dataTransfer.effectAllowed = "copy";
              } else {
                event.preventDefault();
              }
            }}
            onClick={() => activate(row)}
            onKeyDown={(event) => onKeyDown(event, index, row)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(event, entry);
            }}
            className="tree-row"
            style={{ paddingLeft: 6 + row.depth * 14,
              ...(activeDrag && highlight === entry.path ? dropOutline : {}),
              opacity: activeDrag?.entry === entry ? 0.55 : undefined,
            }}
          >
            <span
              aria-hidden="true"
              className="tree-caret"
              style={{ transform: isExpanded ? "rotate(90deg)" : undefined }}
            >
              {entry.isDirectory ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              ) : null}
            </span>

            <FileIcon name={entry.name} isDirectory={entry.isDirectory} expanded={isExpanded} />

            <span className="tree-name">{entry.name}</span>

            {entry.isSymlink ? (
              <span aria-hidden="true" className="tree-mark">
                ↪
              </span>
            ) : null}

            {/* git 状态：徽标（哪一类变化）+ 行尾的增删行数（改了多少）。
                目录上是子树的汇总，所以带一个受影响文件数而不是行数。 */}
            {entry.git ? (
              <>
                <span
                  className="git-badge"
                  style={{ color: gitColor(entry.git.status) }}
                  title={gitTitle(entry.git, t)}
                >
                  {gitGlyph(entry.git.status)}
                  {entry.isDirectory && typeof entry.git.changed === "number" ? (
                    <span className="git-badge-count">{entry.git.changed}</span>
                  ) : null}
                </span>
                {!entry.isDirectory && (entry.git.added > 0 || entry.git.deleted > 0) ? (
                  <span className="git-stats" title={gitTitle(entry.git, t)}>
                    {entry.git.added > 0 ? <span className="git-add">+{entry.git.added}</span> : null}
                    {entry.git.deleted > 0 ? <span className="git-del">−{entry.git.deleted}</span> : null}
                  </span>
                ) : null}
              </>
            ) : null}

            {entry.isDirectory ? null : (
              <span className="tree-size">{formatSize(entry.size)}</span>
            )}
          </button>
        );
      })}
      {activeDrag && canMoveTo(activeDrag.entry, null) ? (
        <div data-root-drop="" className="sticky bottom-0 rounded border border-dashed px-2 py-1 text-center text-xs"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)", ...(highlight === "" ? dropOutline : {}) }}>
          {t("dropAtRoot")}
        </div>
      ) : null}
    </div>
  );
}
