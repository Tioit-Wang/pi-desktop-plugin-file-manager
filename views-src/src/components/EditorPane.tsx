import { useEffect, useRef, useState } from "react";
import { createEditor, type EditorHandle } from "../lib/editor";
import type { Base } from "../lib/appearance";
import type { T } from "../i18n";
import { baseNameOf, formatSize, formatTime } from "../lib/format";
import { FileIcon } from "../lib/fileIcons";
import { MarkdownPreview } from "../lib/markdown";
import { MODE_LABEL, csvDelimiterOf, type ViewerMode, type ViewerView } from "../lib/viewers";
import { isDocumentLoaded, type OpenFile } from "../lib/openFile";
import { CsvTable } from "./CsvTable";
import { ImageView } from "./ImageView";
import { JsonTree } from "./JsonTree";
import { MediaPlayer } from "./MediaPlayer";
import { SqliteView } from "./SqliteView";

type Props = {
  file: OpenFile | null;
  base: Base;
  locale: "en" | "zh";
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** 当前文件可用的视图模式（源码 / Markdown / 表格 / 树）；纯文本为 null。 */
  viewer: ViewerView | null;
  /** 表格每页行数（偏好里记着）。 */
  tablePageSize: number;
  t: T;
  handleRef: React.MutableRefObject<EditorHandle | null>;
  onDirty: () => void;
  onSave: () => void;
  onReload: () => void;
  onViewerMode: (mode: ViewerMode) => void;
  onTablePageSize: (size: number) => void;
  onLink: (url: string) => void;
};

export function EditorPane({
  file,
  base,
  locale,
  dirty,
  saving,
  error,
  viewer,
  tablePageSize,
  t,
  handleRef,
  onDirty,
  onSave,
  onReload,
  onViewerMode,
  onTablePageSize,
  onLink,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 编辑器里装的是哪一次「从磁盘读进来」的内容；null = 还没装。
  const [loadedToken, setLoadedToken] = useState<number | null>(null);

  // 编辑器只在挂载时创建一次，所以回调必须经 ref 转发，
  // 否则 Ctrl+S 会一直调用「首帧那次渲染」闭包里的 onSave（那时还没有打开文件）。
  const handlersRef = useRef({ onDirty, onSave });
  handlersRef.current = { onDirty, onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createEditor(host, {
      base,
      onDocChanged: () => handlersRef.current.onDirty(),
      onSave: () => handlersRef.current.onSave(),
    });
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setBase(base);
  }, [base, handleRef]);

  // 只有「从磁盘重新装载」才替换文档。保存成功后 openFile 也会换新对象
  // （mtime / size 变了），但 loadToken 不变——那一步必须原样跳过，否则会把
  // 用户刚写的内容换成打开时那份，光标与滚动位置也一起丢。
  useEffect(() => {
    if (!file) {
      // 换文件夹（或关闭文件）之后，编辑器里不能还留着上一个文件夹的那份文档：
      // 面板上已经是空态，缓冲区却还在——切回同一相对路径的文件、或者误按
      // Ctrl+S 都会撞见别人的内容。只有装过文档（loadToken 非空）才需要清一次；
      // setDocument 会抑制 change 回调，不会把脏标记点亮。
      if (loadedToken !== null) {
        handleRef.current?.setDocument("", "", true);
        setLoadedToken(null);
      }
      return;
    }
    if (loadedToken === file.loadToken) return;
    handleRef.current?.setDocument(file.text, file.path, file.kind !== "text");
    setLoadedToken(file.loadToken);
  }, [file, loadedToken, handleRef]);

  // 预览、表格、树渲染的是「编辑器里当前那份文本」，不是打开时的那份：
  // 改完再切过去必须看到刚写的内容。文件刚换、上面的 effect 还没跑时，
  // handle 里装的仍是上一个文件，此时退回 file.text（保存后它也是最新的）。
  const mode = viewer?.mode ?? "source";
  const structured = Boolean(file && viewer && mode !== "source");
  const imageSrc = file?.kind === "image" ? file.dataUri : undefined;
  const mediaSrc = file?.kind === "media" ? file.dataUri : undefined;
  const sqlite = file?.kind === "sqlite" ? file.sqlite : undefined;
  const editorHidden = structured || Boolean(imageSrc) || Boolean(mediaSrc) || Boolean(sqlite);

  const liveText =
    isDocumentLoaded(file, loadedToken) && file
      ? handleRef.current?.text() ?? file.text
      : file?.text ?? "";
  const structuredText = structured ? liveText : "";

  // 预览或查看器占位时编辑器必须藏起来、且要 false 掉 CodeMirror 的测量：
  // 它在 display:none 的容器里量不到尺寸，回到编辑态会排版错乱。
  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.style.display = editorHidden ? "none" : "";
    if (!editorHidden) handleRef.current?.view.requestMeasure();
  }, [editorHidden, handleRef]);

  // 图片与音视频是「查看」而不是「编辑」，不再挂只读横幅——换成查看器本身。
  const readOnlyReason =
    file && file.kind !== "text"
      ? file.kind === "binary"
        ? t("binary")
        : file.kind === "tooLarge"
          ? t("tooLarge")
          : null
      : null;

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("title")}>
      <header
        className="flex min-h-[42px] flex-none items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        {file ? (
          <>
            <FileIcon name={baseNameOf(file.path)} isDirectory={false} />
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px]"
              title={file.path}
              dir="rtl"
            >
              {file.path}
            </span>
            <span className="flex-none text-[10px] tabular-nums" style={{ color: "var(--muted)" }}>
              {formatSize(file.size)}
            </span>
            {file.kind === "text" ? (
              <span className="flex-none text-[10px]" style={{ color: "var(--muted)" }}>
                {dirty ? t("dirty") : saving ? t("saving") : t("saved")}
              </span>
            ) : null}

            {viewer ? (
              <div
                role="tablist"
                aria-label={t("viewMode")}
                className="flex flex-none items-center gap-0.5 rounded-md p-0.5"
                style={{ background: "var(--surface-hover)" }}
              >
                {viewer.modes.map((candidate) => {
                  const active = viewer.mode === candidate;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => onViewerMode(candidate)}
                      className="rounded border-0 px-2 py-[3px] text-[11px] transition-colors"
                      style={{
                        background: active ? "var(--accent)" : "transparent",
                        color: active ? "var(--bg)" : "var(--secondary)",
                      }}
                    >
                      {t(MODE_LABEL[candidate])}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* 一直可用：没有文件监听，外部改动只能靠这里拉进来。
                以前「没有未保存改动」时它是灰的，于是「文件在别处被改了，
                我想看看新的」正好点不动。有未保存改动时会先弹确认。 */}
            <IconButton
              label={t("reload")}
              onClick={onReload}
              d="M20 11a8 8 0 0 0-14.9-3.9L3 9M3 4v5h5M4 13a8 8 0 0 0 14.9 3.9L21 15M21 20v-5h-5"
            />
            <IconButton
              label={t("save")}
              disabled={!dirty || saving || file.kind !== "text"}
              onClick={onSave}
              d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"
            />
          </>
        ) : (
          <span className="px-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
            {t("projectFiles")}
          </span>
        )}
      </header>

      {error ? (
        <div
          className="flex-none px-3 py-2 text-[11.5px]"
          role="alert"
          style={{
            background: "color-mix(in oklab, var(--danger) 14%, transparent)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {readOnlyReason ? (
        <div
          className="flex flex-none items-center gap-2 px-3 py-2 text-[11.5px]"
          style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}
        >
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--surface-hover)", color: "var(--secondary)" }}
          >
            {t("readOnly")}
          </span>
          <span>{readOnlyReason}</span>
          {typeof file?.limit === "number" ? (
            <span style={{ color: "var(--faint)" }}>
              {t("limitHint", { limit: formatSize(file.limit) })}
            </span>
          ) : null}
          {file ? (
            <span className="ml-auto" style={{ color: "var(--faint)" }}>
              {formatTime(file.mtimeMs, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="h-full" />

        {structured && file && mode === "markdown" ? (
          <div className="md-scroll">
            <div className="md-body">
              <MarkdownPreview text={structuredText} base={base} onLink={onLink} />
            </div>
          </div>
        ) : null}

        {structured && file && mode === "table" ? (
          <CsvTable
            text={structuredText}
            delimiter={csvDelimiterOf(file.path) ?? ","}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {structured && file && mode === "tree" ? <JsonTree text={structuredText} t={t} /> : null}

        {file && imageSrc ? (
          <ImageView key={file.path} src={imageSrc} name={baseNameOf(file.path)} size={file.size} t={t} />
        ) : null}

        {file && mediaSrc ? (
          <MediaPlayer
            key={file.path}
            src={mediaSrc}
            mime={file.mime ?? ""}
            name={baseNameOf(file.path)}
            size={file.size}
            t={t}
          />
        ) : null}

        {file && sqlite ? (
          <SqliteView
            // 带上 loadToken：工具栏的「重新加载」会重新读一次头部，key 一变就重挂载，
            // schema 与当前页数据跟着刷新（数据库不能被编辑，所以只有这一种变化来源）
            key={`${file.path}#${file.loadToken}`}
            path={file.path}
            info={sqlite.info}
            available={sqlite.available}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {!file ? (
          <div
            className="absolute inset-0 flex items-center justify-center px-6 text-center"
            style={{ background: "var(--bg)", color: "var(--muted)" }}
          >
            <span className="max-w-[34ch] text-[12px] leading-relaxed">{t("searchHint")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function IconButton({
  label,
  d,
  onClick,
  disabled,
}: {
  label: string;
  d: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-xl border-0 bg-transparent transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] disabled:cursor-default disabled:opacity-40"
      style={{ color: "var(--secondary)" }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    </button>
  );
}
