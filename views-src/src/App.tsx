import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./lib/bridge";
import { watchAppearance, type Base, type Locale as HostLocale } from "./lib/appearance";
import { watchWorkspace, type Workspace } from "./lib/workspace";
import { channels, failureMessage, isConflict, type Failure, type FileEntry, type ListResponse, type Prefs, type ReadResponse, type SearchHit, type SearchResponse, type WriteResponse } from "./lib/rpc";
import { baseNameOf, parentOf } from "./lib/format";
import { makeT, type T } from "./i18n";
import { resolveViewer, type ViewerMode } from "./lib/viewers";
import { toOpenFile, withSavedContent, type OpenFile } from "./lib/openFile";
import { openWithDefaultApp, revealInFileManager } from "./lib/hostActions";
import { Tree, type DirState } from "./components/Tree";
import { EditorPane } from "./components/EditorPane";
import { ConfirmDialog, PromptDialog } from "./components/Dialogs";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import type { EditorHandle } from "./lib/editor";

type SearchState = { hits: SearchHit[]; running: boolean; done: boolean };

type Guard = { body: string } | null;
type Prompt =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "move"; entry: FileEntry }
  | null;
type Conflict = { mtimeMs: number; size: number } | null;
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

const SEARCH_PAGE = 60;

export default function App() {
  const [hostLocale, setHostLocale] = useState<HostLocale>("en");
  const [base, setBase] = useState<Base>(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const t: T = useMemo(() => makeT(hostLocale), [hostLocale]);

  const [root, setRoot] = useState<Workspace | null>(null);
  const [directories, setDirectories] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    splitRatio: 0.32,
    showIgnored: false,
    mdPreview: false,
    csvTable: true,
    jsonTree: false,
    tablePageSize: 1000,
  });
  const [ignoreActive, setIgnoreActive] = useState(false);
  const [guard, setGuard] = useState<Guard>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ hits: [], running: false, done: true });

  const handleRef = useRef<EditorHandle | null>(null);
  const dirsRef = useRef(directories);
  const revisionRef = useRef(0);
  const openTokenRef = useRef(0);
  const searchTokenRef = useRef(0);
  // 每次「从磁盘装载」递增，写进 OpenFile.loadToken：编辑器据此区分
  // 「换文件 / 重新加载」与「保存后更新 mtime」。见 lib/openFile.ts。
  const loadTokenRef = useRef(0);
  const saveRef = useRef<(override?: { mtimeMs: number; size: number }) => Promise<boolean>>(
    async () => false,
  );
  /** 正在进行的保存（含目标路径）。同一个文件的重复请求复用它，不发出第二次写。 */
  const inFlightRef = useRef<{ path: string; promise: Promise<boolean> } | null>(null);
  /** 保存是异步的：回来时用户可能已经切走，元数据与脏标记不能落到新文件上。 */
  const openPathRef = useRef<string | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const loadRef = useRef<(path: string, force?: boolean) => Promise<void>>(async () => {});

  // 让回调读到最新值而不必重订阅。
  const dirtyRef = useRef(dirty);
  const currentNameRef = useRef("");
  const tRef = useRef(t);

  dirsRef.current = directories;
  dirtyRef.current = dirty;
  openPathRef.current = openFile ? openFile.path : null;
  currentNameRef.current = openFile ? baseNameOf(openFile.path) : t("projectFiles");
  tRef.current = t;

  // ── 外观 ─────────────────────────────────────────────────────────────────

  useEffect(
    () =>
      watchAppearance((_appearance, nextBase, nextLocale) => {
        setBase(nextBase);
        setHostLocale(nextLocale);
      }),
    [],
  );

  // ── 工作区切换 ───────────────────────────────────────────────────────────

  useEffect(() => {
    // 订阅工作区变化：路径一变就整体重载（宿主没有给 workpanel 的工作区事件，
    // 只能靠 workspace.get 的轮询）。有未保存内容时先走守卫。
    // 依赖保持为空：watchWorkspace 订阅时会立刻发一次首次结果，若把 t 放进
    // 依赖，切换语言就会重订阅并再次触发「工作区变化」，把树和文件全清掉。
    return watchWorkspace((workspace) => {
      const apply = () => {
        revisionRef.current += 1;
        setRoot(workspace);
        setDirectories(new Map());
        setExpanded(new Set());
        setSelected(null);
        setOpenFile(null);
        setDirty(false);
        setError(null);
        setQuery("");
        setSearch({ hits: [], running: false, done: true });
        if (workspace) void loadRef.current("", true);
      };

      if (dirtyRef.current) {
        pendingRef.current = apply;
        setGuard({ body: tRef.current("dirtyPromptBody", { name: currentNameRef.current }) });
      } else {
        apply();
      }
    });
  }, []);

  // 首次加载：拿偏好与根目录。
  useEffect(() => {
    void (async () => {
      try {
        const hello = await invoke<{ ok: true; root: Workspace | null; prefs: Prefs }>(
          channels.hello,
        );
        if (hello?.ok) {
          setPrefs(hello.prefs);
          setRoot(hello.root);
        }
      } catch {
        /* 根目录由 watchWorkspace 兜底 */
      }
    })();
  }, []);

  // ── 目录操作 ─────────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string, force = false) => {
      const revision = revisionRef.current;
      const existing = dirsRef.current.get(path);
      if (!force && existing?.entries && !existing.loading) return;

      const setDir = (state: DirState) =>
        setDirectories((prev) => {
          const next = new Map(prev);
          next.set(path, state);
          return next;
        });

      setDir({ loading: true });
      try {
        const response = await invoke<ListResponse | Failure>(channels.list, { path });
        if (revision !== revisionRef.current) return;
        if (!response.ok) {
          setDir({ error: failureMessage(response, t) });
          return;
        }
        setDir({ entries: response.entries });
        // 「项目里有没有忽略规则」只有根目录那次列表能回答，用来提示用户
        // 树里为什么少了一些条目（工具栏的眼睛按钮可以切回显示）。
        if (path === "") setIgnoreActive(response.ignoreActive);
      } catch (cause) {
        if (revision !== revisionRef.current) return;
        setDir({ error: String((cause as Error).message) });
      }
    },
    [t],
  );

  // 工作区切换的回调在 effect 里注册一次，通过 ref 拿到最新的加载函数。
  loadRef.current = loadDirectory;

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      void loadDirectory(path);
    },
    [loadDirectory],
  );

  const refreshTree = useCallback(() => {
    const open = [...expanded];
    setDirectories(new Map());
    void (async () => {
      await loadDirectory("", true);
      for (const path of open) await loadDirectory(path, true);
    })();
  }, [expanded, loadDirectory]);

  // ── 打开 / 保存 ──────────────────────────────────────────────────────────

  const openEntry = useCallback(
    async (entry: FileEntry) => {
      const token = ++openTokenRef.current;
      setSelected(entry.path);
      setError(null);
      try {
        const response = await invoke<ReadResponse | Failure>(channels.read, { path: entry.path });
        if (token !== openTokenRef.current) return;
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        loadTokenRef.current += 1;
        setOpenFile(toOpenFile(response, loadTokenRef.current));
        setDirty(false);
      } catch (cause) {
        if (token !== openTokenRef.current) return;
        setError(String((cause as Error).message));
      }
    },
    [t],
  );

  const withGuard = useCallback(
    (action: () => void) => {
      if (!dirtyRef.current) {
        action();
        return;
      }
      pendingRef.current = action;
      setGuard({ body: t("dirtyPromptBody", { name: currentNameRef.current }) });
    },
    [t],
  );

  const requestOpen = useCallback(
    (entry: FileEntry) => {
      if (entry.path === openFile?.path) return;
      withGuard(() => void openEntry(entry));
    },
    [openEntry, openFile?.path, withGuard],
  );

  const persistPrefs = useCallback((partial: Partial<Prefs>) => {
    setPrefs((prev) => ({ ...prev, ...partial }));
    void invoke(channels.prefsSet, { partial }).catch(() => {});
  }, []);

  const save = useCallback(
    async (override?: { mtimeMs: number; size: number }): Promise<boolean> => {
      if (!openFile || openFile.kind !== "text") return false;
      // 没有改动就不写盘：Ctrl+S 是习惯动作，不该白抬一次 mtime、白记一行审计，
      // 更不该因为文件在别处被改过而弹出一个「冲突」。带 override 的是冲突框里的
      // 「覆盖」，那是显式意图，照写。
      if (!override && !dirtyRef.current) return false;
      // 同一个文件上一次保存还没回来：复用那次结果。连按两下 Ctrl+S 不会发出
      // 第二次写，也就不会用同一个 mtime 期望值把自己撞成 CONFLICT。
      if (inFlightRef.current?.path === openFile.path) return inFlightRef.current.promise;

      const target = openFile;
      const text = handleRef.current?.text() ?? target.text;

      const run = (async (): Promise<boolean> => {
        setSaving(true);
        setError(null);
        try {
          const response = await invoke<WriteResponse>(channels.write, {
            path: target.path,
            text,
            expectedMtimeMs: override?.mtimeMs ?? target.mtimeMs,
            expectedSize: override?.size ?? target.size,
            eol: target.eol,
            bom: target.bom,
          });

          // 写是成功了，但用户可能已经切走——那就只认这次写的成功，别把
          // 元数据、脏标记、冲突框落到另一个文件上。
          if (openPathRef.current !== target.path) return response.ok;

          if (response.ok) {
            // 只更新元数据（下一次乐观锁的期望值）与文本，loadToken 不动：
            // 编辑器里的文档就是刚存下去的那份，不该被重装。
            setOpenFile((prev) => (prev ? withSavedContent(prev, response, text) : prev));
            setDirty(false);
            void loadDirectory(parentOf(target.path), true);
            return true;
          }
          if (isConflict(response)) {
            setConflict({ mtimeMs: response.mtimeMs, size: response.size });
            return false;
          }
          setError(failureMessage(response, t));
          return false;
        } catch (cause) {
          if (openPathRef.current === target.path) setError(String((cause as Error).message));
          return false;
        } finally {
          setSaving(false);
        }
      })();

      inFlightRef.current = { path: target.path, promise: run };
      try {
        return await run;
      } finally {
        if (inFlightRef.current?.promise === run) inFlightRef.current = null;
      }
    },
    [loadDirectory, openFile, t],
  );

  saveRef.current = save;

  // Ctrl/Cmd+S 在编辑器之外也得能用：点了工具栏按钮、或正停在预览 / 表格 / 树
  // 视图时，焦点不在 CodeMirror 里，编辑器自己的键位收不到这个键。编辑器内部的
  // 绑定保留——它先跑并 preventDefault，这里据此跳过，不会保存两次。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reloadFromDisk = useCallback(() => {
    if (!openFile) return;
    withGuard(() => void openEntry({ path: openFile.path } as FileEntry));
  }, [openEntry, openFile, withGuard]);

  // ── 搜索 ─────────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (needle: string) => {
    const token = ++searchTokenRef.current;
    if (!needle.trim()) {
      setSearch({ hits: [], running: false, done: true });
      return;
    }
    setSearch({ hits: [], running: true, done: false });

    let cursor: string | null = null;
    for (let round = 0; round < 60; round += 1) {
      let response: SearchResponse | Failure;
      try {
        response = await invoke<SearchResponse>(channels.search, {
          query: needle,
          cursor,
          limit: SEARCH_PAGE,
        });
      } catch {
        if (token !== searchTokenRef.current) return;
        setSearch({ hits: [], running: false, done: true });
        return;
      }
      if (token !== searchTokenRef.current) return;
      if (!response.ok) {
        setSearch({ hits: [], running: false, done: true });
        return;
      }
      cursor = response.nextCursor;
      const matches = response.matches;
      setSearch((prev) => ({
        hits: [...prev.hits, ...matches],
        running: !response.done,
        done: response.done,
      }));
      if (response.done) return;
    }
    setSearch((prev) => ({ ...prev, running: false, done: true }));
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      searchTokenRef.current += 1;
      setSearch({ hits: [], running: false, done: true });
      return;
    }
    const timer = window.setTimeout(() => void runSearch(query), 220);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  // ── 分割条 ───────────────────────────────────────────────────────────────

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const container = bodyRef.current;
    if (!container) return;
    let latest = prefs.splitRatio;

    const onMove = (move: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      latest = Math.min(Math.max((move.clientX - rect.left) / rect.width, 0.15), 0.7);
      setPrefs((prev) => ({ ...prev, splitRatio: latest }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistPrefs({ splitRatio: latest });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── 新建 / 重命名 / 移动 ─────────────────────────────────────────────────

  const onPromptSubmit = async (value: string) => {
    const active = prompt;
    setPrompt(null);
    if (!active) return;
    try {
      if (active.kind === "newFile" || active.kind === "newFolder") {
        const response = await invoke<{ ok: true } | Failure>(channels.create, {
          parent: active.parent,
          name: value,
          isDirectory: active.kind === "newFolder",
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        await loadDirectory(active.parent, true);
        if (active.parent) setExpanded((prev) => new Set(prev).add(active.parent));
      } else if (active.kind === "rename") {
        const response = await invoke<{ ok: true } | Failure>(channels.rename, {
          path: active.entry.path,
          newName: value,
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        await loadDirectory(parentOf(active.entry.path), true);
        setSelected((prev) => (prev === active.entry.path ? null : prev));
      } else {
        const response = await invoke<{ ok: true } | Failure>(channels.move, {
          from: active.entry.path,
          toDir: value,
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        await loadDirectory(parentOf(active.entry.path), true);
        await loadDirectory(value, true);
        setExpanded((prev) => new Set(prev).add(value));
      }
    } catch (cause) {
      setError(String((cause as Error).message));
    }
  };

  const refreshSelectedDirectory = () => {
    const target = selected ? parentOf(selected) : "";
    void loadDirectory(target, true);
  };

  const openMenu = (event: React.MouseEvent, entry: FileEntry | null) => {
    if (entry) setSelected(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  /** 链接不导航：视图一旦离开插件页面就回不来了，而本插件也没申报
   *  shell.openExternal。所以点击的语义是把地址告诉用户。 */
  const onLink = useCallback(
    (url: string) => {
      void invoke("ui.showToast", { message: tRef.current("linkHint", { url }) }).catch(() => {});
    },
    [],
  );

  /**
   * 「用默认应用打开」与「在文件夹中显示」由宿主代为执行（fs.openDefault / fs.reveal），
   * 受 manifest 里声明的 fs.read 范围约束，且只对文件有效。
   * 失败走 toast 而不是插件的错误横幅——这两件事与当前打开的文件无关。
   */
  const runHostAction = useCallback((action: "open" | "reveal", path: string) => {
    const run = action === "open" ? openWithDefaultApp : revealInFileManager;
    void run(path).catch(() => {
      void invoke("ui.showToast", {
        message: tRef.current(action === "open" ? "openError" : "revealError"),
      }).catch(() => {});
    });
  }, []);

  // 结构化视图（Markdown 预览 / 表格 / 树）只对文本文件成立；具体有哪几种、
  // 默认落在哪一侧，全部由 lib/viewers.ts 一处判定，偏好决定默认值。
  const viewer = openFile && openFile.kind === "text" ? resolveViewer(openFile.path, prefs) : null;

  const changeViewerMode = (mode: ViewerMode) => {
    if (!viewer) return;
    if (viewer.modes.includes("markdown")) persistPrefs({ mdPreview: mode === "markdown" });
    else if (viewer.modes.includes("table")) persistPrefs({ csvTable: mode === "table" });
    else if (viewer.modes.includes("tree")) persistPrefs({ jsonTree: mode === "tree" });
  };

  const menuEntries = (): MenuEntry[] => {
    const target = menu?.entry ?? null;
    const isDir = Boolean(target?.isDirectory);
    const dirPath = target ? (isDir ? target.path : parentOf(target.path)) : "";

    const entries: MenuEntry[] = [
      {
        kind: "item",
        label: t("newFile"),
        onPick: () => setPrompt({ kind: "newFile", parent: dirPath }),
      },
      {
        kind: "item",
        label: t("newFolder"),
        onPick: () => setPrompt({ kind: "newFolder", parent: dirPath }),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: t("rename"),
        disabled: !target,
        onPick: () => target && setPrompt({ kind: "rename", entry: target }),
      },
      {
        kind: "item",
        label: t("move"),
        disabled: !target,
        onPick: () => target && setPrompt({ kind: "move", entry: target }),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: t("refresh"),
        onPick: () => void loadDirectory(dirPath, true),
      },
    ];

    if (target && !isDir) {
      // 三个都是「对这个文件动手」，插在分隔线之后、重命名之前。
      // 后两个交给宿主执行，且只对文件有效（宿主会对目录报 INVALID_ARGUMENT）。
      entries.splice(
        3,
        0,
        {
          kind: "item",
          label: t("open"),
          onPick: () => withGuard(() => void openEntry(target)),
        },
        {
          kind: "item",
          label: t("openWithApp"),
          onPick: () => runHostAction("open", target.path),
        },
        {
          kind: "item",
          label: t("revealInFolder"),
          onPick: () => runHostAction("reveal", target.path),
        },
      );
    }
    return entries;
  };

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  const searchActive = query.trim().length > 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <header
        className="flex min-h-[38px] flex-none flex-wrap items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--icon-folder)" }} aria-hidden="true">
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          <span className="min-w-0 truncate text-[12.5px] font-medium">
            {root?.name ?? t("title")}
          </span>
        </span>

        <span className="ml-auto flex flex-none items-center gap-1">
          <IconButton label={t("newFile")} onClick={() => setPrompt({ kind: "newFile", parent: selectedDirPath() })}>
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
            <path d="M12 11v6M9 14h6" />
          </IconButton>
          <IconButton label={t("newFolder")} onClick={() => setPrompt({ kind: "newFolder", parent: selectedDirPath() })}>
            <path d="M12 10v6M9 13h6" />
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </IconButton>
          <IconButton label={t("rename")} disabled={!selected} onClick={() => selectedEntry() && setPrompt({ kind: "rename", entry: selectedEntry()! })}>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </IconButton>
          <IconButton label={t("move")} disabled={!selected} onClick={() => selectedEntry() && setPrompt({ kind: "move", entry: selectedEntry()! })}>
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </IconButton>
          <IconButton label={t("refresh")} onClick={refreshTree}>
            <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
            <path d="M3 4v5h5" />
            <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
            <path d="M21 20v-5h-5" />
          </IconButton>
          <IconButton
            label={prefs.showIgnored ? t("hideIgnored") : t("showIgnored")}
            active={prefs.showIgnored}
            onClick={() => persistPrefs({ showIgnored: !prefs.showIgnored })}
          >
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </IconButton>
        </span>
      </header>

      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <aside
          className="flex min-h-0 min-w-0 flex-col"
          style={{ width: `${prefs.splitRatio * 100}%`, background: "var(--surface)" }}
        >
          <div className="flex flex-none items-center gap-1.5 px-2.5 pb-1.5 pt-2">
            <div className="relative flex min-w-0 flex-1 items-center">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--faint)", position: "absolute", left: 7 }} aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("search")}
                className="w-full rounded-md border py-1 pl-6 pr-6 text-[11.5px] outline-none"
                style={{ borderColor: "var(--border-strong)", background: "var(--bg)", color: "var(--fg)" }}
              />
              {query ? (
                <button
                  type="button"
                  aria-label={t("clear")}
                  onClick={() => setQuery("")}
                  className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent"
                  style={{ color: "var(--faint)" }}
                >
                  ×
                </button>
              ) : null}
            </div>
            <IconButton label={t("refresh")} small onClick={refreshSelectedDirectory}>
              <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
              <path d="M3 4v5h5" />
              <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
              <path d="M21 20v-5h-5" />
            </IconButton>
          </div>

          <div className="flex flex-none items-center justify-between gap-2 px-3 pb-1 text-[10.5px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            <span>{searchActive ? t("search") : t("treeSection")}</span>
            <span className="tabular-nums" style={{ color: "var(--faint)" }}>
              {searchActive
                ? search.running
                  ? t("searchScanning")
                  : String(search.hits.length)
                : ""}
            </span>
          </div>

          {searchActive ? (
            <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4" role="listbox" aria-label={t("search")}>
              {search.hits.length === 0 && !search.running ? (
                <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
                  {t("searchEmpty")}
                </div>
              ) : null}
              {search.hits.map((hit) => (
                <button
                  key={hit.path}
                  type="button"
                  role="option"
                  aria-selected={selected === hit.path}
                  title={hit.path}
                  onClick={() => {
                    const path = hit.path;
                    withGuard(() => {
                      setQuery("");
                      const segments = path.split("/");
                      const parents: string[] = [];
                      for (let index = 1; index < segments.length; index += 1) {
                        parents.push(segments.slice(0, index).join("/"));
                      }
                      setExpanded((prev) => new Set([...prev, ...parents]));
                      if (hit.isDirectory) {
                        void loadDirectory(path, true).then(() => setSelected(path));
                        void (async () => {
                          for (const parent of parents) await loadDirectory(parent);
                        })();
                      } else {
                        setSelected(path);
                        void (async () => {
                          for (const parent of parents) await loadDirectory(parent);
                          await openEntry({ path, name: hit.name, isDirectory: false } as FileEntry);
                        })();
                      }
                    });
                  }}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 px-2 py-[3px] text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
                  style={{ color: "var(--secondary)", minHeight: 24 }}
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {hit.name}
                  </span>
                  <span className="flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[10px]" style={{ color: "var(--faint)", maxWidth: "45%" }} dir="rtl">
                    {parentOf(hit.path)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Tree
              directories={directories}
              expanded={expanded}
              selected={selected}
              showIgnored={prefs.showIgnored}
              t={t}
              onToggle={toggleDirectory}
              onOpen={requestOpen}
              onRefreshDir={(path) => void loadDirectory(path, true)}
              onContextMenu={openMenu}
            />
          )}

          {prefs.showIgnored || !ignoreActive ? null : (
            <div className="flex-none px-3 pb-2 text-[10.5px]" style={{ color: "var(--faint)" }}>
              {t("ignoredHidden")}
            </div>
          )}
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize"
          onMouseDown={startResize}
          className="w-[3px] flex-none cursor-col-resize transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: "var(--border)" }}
        />

        <EditorPane
          file={openFile}
          base={base}
          locale={hostLocale}
          dirty={dirty}
          saving={saving}
          error={error}
          viewer={viewer}
          tablePageSize={prefs.tablePageSize}
          t={t}
          handleRef={handleRef}
          onDirty={() => setDirty(true)}
          onSave={() => void save()}
          onReload={reloadFromDisk}
          onViewerMode={changeViewerMode}
          onTablePageSize={(size) => persistPrefs({ tablePageSize: size })}
          onLink={onLink}
        />
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />
      ) : null}

      {!root ? (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "var(--bg)" }}>
          <div className="max-w-[32ch] text-center">
            <div className="mb-1 text-[15px] font-medium" style={{ color: "var(--fg)" }}>
              {t("noWorkspaceTitle")}
            </div>
            <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("noWorkspaceCopy")}
            </div>
          </div>
        </div>
      ) : null}

      {guard ? (
        <ConfirmDialog
          title={t("dirtyPromptTitle")}
          body={guard.body}
          actions={[
            {
              label: t("cancel"),
              onPick: () => {
                pendingRef.current = null;
                setGuard(null);
              },
            },
            {
              label: t("discardAndSwitch"),
              variant: "danger",
              onPick: () => {
                const next = pendingRef.current;
                pendingRef.current = null;
                setGuard(null);
                setDirty(false);
                next?.();
              },
            },
            {
              label: t("saveAndSwitch"),
              variant: "primary",
              onPick: () => {
                const next = pendingRef.current;
                pendingRef.current = null;
                void save().then((ok) => {
                  setGuard(null);
                  if (ok) next?.();
                });
              },
            },
          ]}
        />
      ) : null}

      {conflict ? (
        <ConfirmDialog
          title={t("conflictTitle")}
          body={t("conflictBody", { name: openFile ? baseNameOf(openFile.path) : "" })}
          actions={[
            { label: t("cancel"), onPick: () => setConflict(null) },
            {
              label: t("discardAndSwitch"),
              variant: "danger",
              onPick: () => {
                setConflict(null);
                setDirty(false);
                if (openFile) void openEntry({ path: openFile.path } as FileEntry);
              },
            },
            {
              label: t("overwrite"),
              variant: "primary",
              onPick: () => {
                const current = conflict;
                setConflict(null);
                void save({ mtimeMs: current.mtimeMs, size: current.size });
              },
            },
          ]}
        />
      ) : null}

      {prompt ? (
        <PromptDialog
          title={
            prompt.kind === "newFolder"
              ? t("newFolderTitle")
              : prompt.kind === "newFile"
                ? t("newFileTitle")
                : prompt.kind === "rename"
                  ? t("renameTitle")
                  : t("moveTitle")
          }
          hint={
            prompt.kind === "newFile" || prompt.kind === "newFolder"
              ? t("createIn", { path: prompt.parent || "." })
              : prompt.kind === "rename"
                ? t("renameFrom", { path: prompt.entry.path })
                : t("moveHint")
          }
          label={prompt.kind === "move" ? t("moveToLabel") : t("nameLabel")}
          initialValue={
            prompt.kind === "rename"
              ? prompt.entry.name
              : prompt.kind === "move"
                ? parentOf(prompt.entry.path)
                : ""
          }
          confirmLabel={prompt.kind === "rename" ? t("confirm") : prompt.kind === "move" ? t("move") : t("create")}
          t={t}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => void onPromptSubmit(value)}
        />
      ) : null}
    </div>
  );

  function selectedEntry(): FileEntry | null {
    if (!selected) return null;
    const parent = parentOf(selected);
    const entry = dirsRef.current.get(parent)?.entries?.find((item) => item.path === selected);
    if (entry) return entry;
    return { path: selected, name: baseNameOf(selected), isDirectory: false } as FileEntry;
  }

  /** 新建时落到「当前选中目录」里；选中文件则落到它所在目录。 */
  function selectedDirPath(): string {
    if (!selected) return "";
    const entry = selectedEntry();
    if (entry?.isDirectory) return entry.path;
    return parentOf(selected);
  }
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
  active,
  small,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  small?: boolean;
}) {
  const size = small ? 24 : 28;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex flex-none items-center justify-center rounded-xl border-0 bg-transparent transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] disabled:cursor-default disabled:opacity-40"
      style={{
        width: size,
        height: size,
        color: active ? "var(--fg)" : "var(--secondary)",
        background: active ? "var(--surface-active)" : undefined,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
