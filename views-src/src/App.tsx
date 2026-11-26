import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./lib/bridge";
import { applyBase, watchAppearance, type Base, type Locale as HostLocale } from "./lib/appearance";
import { watchWorkspace, workspaceKey, type Workspace } from "./lib/workspace";
import { channels, failureMessage, isConflict, type DeleteResponse, type EditorOption, type EditorsResponse, type Failure, type FileEntry, type GitSummary, type HelloResponse, type ListResponse, type Prefs, type PrefsResponse, type ReadRequest, type ReadResponse, type RepoContext, type SearchHit, type SearchResponse, type WriteRequest, type WriteResponse } from "./lib/rpc";
import { gitColor, gitGlyph, gitSummaryText, gitTitle } from "./lib/git";
import { useTreeWatch } from "./lib/useTreeWatch";
import { baseNameOf, formatSize, parentOf } from "./lib/format";
import { absoluteFullPath, absolutePathOf, findRootForPath, hostActionPath, normalizeRoots, primaryRootOf, projectKeyOf, rememberProjectRoot, resolveSelectedRoot, samePath, type WorkspaceRoot } from "./lib/roots";

import { makeT, type T } from "./i18n";
import { MODE_LABEL, resolveViewer, type ViewerMode } from "./lib/viewers";
import { toOpenFile, withSavedContent, type OpenFile } from "./lib/openFile";
import { openInBuiltInBrowser, openWithDefaultApp, openWithEditor, revealInFileManager } from "./lib/hostActions";
import { editorsFor } from "./lib/editors";
import { buildFileContextMenuEntries, withBuiltInBrowserEntry } from "./lib/file-context-menu";
import { copyText } from "./lib/clipboard";
import { isExternalPath, watchHostOpenRequests, type HostOpenRequest } from "./lib/hostOpen";
import { Tree, type DirState } from "./components/Tree";
import { Skeleton } from './components/Skeleton';
import { FileIcon } from "./lib/fileIcons";
import { IconButton } from "./components/IconButton";
import { GitPanel, gitOperationError, type GitSegment } from "./components/GitPanel";
import { ActivityRail, ContentBar, Segmented, StatusBar, createCaretStore, nextTab, segmentId, type SidebarView } from "./components/Workbench";
import { GitSync } from "./components/GitSync";
import { GitIcon, GitIconPath } from "./components/GitIcons";
import { GitCommitDetail } from "./components/GitHistory";
import { GitPreview } from "./components/GitPreview";
import { EditorPane } from "./components/EditorPane";
import { ConfirmDialog, PromptDialog } from "./components/Dialogs";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import type { EditorHandle } from "./lib/editor";
import { useDocumentTabs } from "./lib/documentTabs";
import { contentKind, tabs as paneTabs } from "./lib/pane";
import { scopeFor, useGitWorkspace, type GitScope } from "./lib/gitWorkspace";
import { reviewKey, useReviewTabs, type ReviewTab } from "./lib/reviewTabs";
import { useSidebarSize } from "./lib/sidebarSize";

type SearchState = { hits: SearchHit[]; running: boolean; done: boolean };

type Guard = { body: string; paths: string[] } | null;
type Prompt =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; entry: FileEntry }
  | null;
type Conflict = { path: string; mtimeMs: number; size: number } | null;
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

/** `a/b/c.txt` → ["a", "a/b"]：打开文件前要逐级展开并加载的祖先目录。 */
function ancestorPaths(relPath: string): string[] {
  const segments = relPath.split("/");
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

const SEARCH_PAGE = 60;


export default function App() {
  const [hostLocale, setHostLocale] = useState<HostLocale>("en");
  const [base, setBase] = useState<Base>(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const t: T = useMemo(() => makeT(hostLocale), [hostLocale]);

  const [root, setRoot] = useState<Workspace | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const remoteReadOnly = root?.path.startsWith("remote-project:") === true;
  const [directories, setDirectories] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandToken = useRef(0);
  const [expanding, setExpanding] = useState(false);
  const directoryRequests = useRef(new Map<string, symbol>());
  const [selected, setSelected] = useState<string | null>(null);
  const documents = useDocumentTabs();
  const openFile = documents.active?.file ?? null;
  const dirty = documents.active?.dirty ?? false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    splitRatio: 0.32,
    treeCollapsed: false,
    showIgnored: false,
    watchFiles: true,
    mdPreview: false,
    csvTable: true,
    jsonTree: false,
    tablePageSize: 1000,
    projectRoots: {},
  });
  /** 整个工作区的 git 概览（分支 + 各状态计数），跟着最近一次列表刷新。 */
  const [gitSummary, setGitSummary] = useState<GitSummary | null>(null);
  /**
   * Which view the single sidebar shows. `search` is its own view now: the
   * explorer's inline filter only filters what is already loaded, while the
   * search view walks the whole project.
   */
  const [view, setView] = useState<SidebarView>("files");
  const [gitSegment, setGitSegment] = useState<GitSegment>("changes");
  const [caret] = useState(createCaretStore);
  const [review, dispatchReview] = useReviewTabs();
  const activeReview = review.tabs.find(tab => reviewKey(tab) === review.active);
  const sidebarOpen = !prefs.treeCollapsed;
  /** 这个运行时能不能监听（0.8.0）；不能就把「自动刷新」开关显示成不可用。 */
  const [watchAvailable, setWatchAvailable] = useState(true);
  const [openHtmlInBrowserAvailable, setOpenHtmlInBrowserAvailable] = useState(false);
  /**
   * 打开的文件在外部被改了、而缓冲里还有未保存的改动。
   * 这时**不自动装载**——静默丢掉用户刚敲的字是最糟的一种「自动」；只提示一句，
   * 由用户点「重新加载」（或走原来的未保存确认框）来决定。
   */
  const externalChange = documents.active?.changed ?? false;
  const [ignoreActive, setIgnoreActive] = useState(false);
  const [guard, setGuard] = useState<Guard>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [menu, setMenu] = useState<Menu>(null);
  /** 整个项目的搜索词（「搜索」视图）。 */
  const [query, setQuery] = useState("");
  /** 树里那条即时筛选：只过滤已经加载的目录，不发请求。 */
  const [filter, setFilter] = useState("");
  /** 删除前的确认框（删除不可撤销，必须明确确认）。 */
  const [confirmDelete, setConfirmDelete] = useState<{ entry: FileEntry } | null>(null);
  const [search, setSearch] = useState<SearchState>({ hits: [], running: false, done: true });
  /** 头部左上角切换器的菜单锚点（null = 没打开）。 */
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * 组信息与偏好（含 root 记忆）都到手了。在那之前宿主请求要先排队 —— 不知道
   * 主根是谁就判断不了「相对路径其实指主根」，也不知道基点该不该切。
   */
  const [ready, setReady] = useState(false);
  /** Local editor candidates are cached by the plugin and refreshed after workspace switches. */
  const [editors, setEditors] = useState<EditorOption[] | null>(null);

  const handleRef = useRef<EditorHandle | null>(null);
  const dirsRef = useRef(directories);
  const revisionRef = useRef(0);
  const openTokenRef = useRef(0);
  const watchReadToken = useRef(0);
  const searchTokenRef = useRef(0);
  // 每次「从磁盘装载」递增，写进 OpenFile.loadToken：编辑器据此区分
  // 「换文件 / 重新加载」与「保存后更新 mtime」。见 lib/openFile.ts。
  const loadTokenRef = useRef(0);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  /** 正在进行的保存（含目标路径）。同一个文件的重复请求复用它，不发出第二次写。 */
  const inFlightRef = useRef<{ path: string; promise: Promise<boolean> } | null>(null);
  /** 保存是异步的：回来时用户可能已经切走，元数据与脏标记不能落到新文件上。 */
  const openPathRef = useRef<string | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshChangesRef = useRef<() => void>(() => {});
  const loadRef = useRef<(path: string, force?: boolean) => Promise<FileEntry[] | undefined>>(async () => undefined);
  /** 宿主请求（入口查询串 / view:open 推送）统一走它。 */
  const hostOpenRef = useRef<(request: HostOpenRequest) => void>(() => {});
  /** 宿主请求在 ready 之前到达时先排队，见下面 ready 的 flush effect。 */
  const pendingHostOpenRef = useRef<HostOpenRequest | null>(null);
  /** 组已经到过，但偏好还没到手：那一份先压着，由 hello 放出去。 */
  const pendingWorkspaceRef = useRef<Workspace | null | undefined>(undefined);
  /** hello 回来过（偏好与 root 记忆都知道了）。 */
  const prefsLoadedRef = useRef(false);
  /** 组走完第一轮 applyWorkspace 之前，宿主请求先排队（见 ready 的 flush effect）。 */
  const readyRef = useRef(false);
  /**
   * 已经应用过的组身份，用来吃掉首次的重复投递（workspace.get 与 hello 并发）。
   * 初值刻意是 undefined 而不是 null：null 是「没有打开项目」这个合法身份。
   */
  const appliedKeyRef = useRef<string | null | undefined>(undefined);
  const applyRef = useRef<(workspace: Workspace | null) => void>(() => {});
  /** 最新的一份偏好（含 root 记忆）；跨 await 的回调要读到最新值。 */
  const prefsRef = useRef(prefs);
  const rootRef = useRef<Workspace | null>(root);
  /** 当前基点；宿主请求要先拿它比对「要不要切」。 */
  const activeRootRef = useRef<WorkspaceRoot | null>(null);
  /** 头部切换器的按钮节点：菜单关掉后把焦点还给它。 */
  const rootButtonRef = useRef<HTMLButtonElement | null>(null);
  /** 切换器按钮按下时菜单是否已经开着（见 openRootMenu）。 */
  const armedRef = useRef(false);

  // 让回调读到最新值而不必重订阅。
  const dirtyRef = useRef(dirty);
  const tRef = useRef(t);

  dirsRef.current = directories;
  dirtyRef.current = dirty;
  openPathRef.current = openFile ? openFile.path : null;
  tRef.current = t;
  prefsRef.current = prefs;
  rootRef.current = root;

  // 组里全部 folder root（宿主没给 roots 时只有一个，就是主根）。
  const roots = useMemo(() => (root ? normalizeRoots(root) : []), [root]);
  /**
   * 当前浏览的那个 root：记忆里的路径必须命中组里的 roots，否则退回主根。
   * 选择不额外存一份 state —— prefs.projectRoots 是唯一真相（main.js 也按它
   * 推导包含基点），视图只是把它翻译成名字与路径。
   */
  const activeRoot = useMemo(
    () => (root ? resolveSelectedRoot(roots, prefs.projectRoots[projectKeyOf(root)]) : null),
    [prefs.projectRoots, root, roots],
  );
  /** 头部的名字：看到哪个 folder 就显示哪个。 */
  const headerName = activeRoot?.name ?? root?.name ?? t("title");
  const rootCount = roots.length;

  // 当前基点写给工具回调（宿主请求要先比对「要不要切」）。
  activeRootRef.current = activeRoot;
  /**
   * 组里多于一个 folder 才有切换器；只有一个 root（或老宿主）时头部就是静态标签。
   * ready 之前偏好与 root 记忆都还没到手：这时候切换等于拿一份空记忆去落盘，
   * 而且随后返回的那份旧偏好会把刚选的基点盖回去（视图与主进程的基点就此分叉）。
   * 所以先只显示静态名字——ready 一到它就是开关。
   */
  const switchable = ready && rootCount > 1 && Boolean(activeRoot);

  /**
   * 换项目 / 换基点共用的一段：树、展开、选中、搜索、打开的文件全部重来。
   * revision 递增让还在飞的目录列表结果作废（见 loadDirectory 的守卫）。
   */
  const resetExplorer = useCallback(() => {
    revisionRef.current += 1;
    openTokenRef.current += 1;
    setOpeningPath(null);
    setDirectories(new Map());
    setExpanded(new Set());
    setSelected(null);
    documents.clear();
    setConflict(null);
    pendingRef.current = null;
    setGuard(null);
    setError(null);
    searchTokenRef.current++;
    setQuery("");
    setFilter("");
    setSearch({ hits: [], running: false, done: true });
    setGitSummary(null);
    setIgnoreActive(false);
    setView("files");
    setGitSegment("changes");
    dispatchReview({ type: "clear" });
    expandToken.current++;
    directoryRequests.current.clear();
    setExpanding(false);
    setMenu(null);
  }, []);

  /**
   * 应用一个项目组（workspace.get / hello 的结果）。同一个组重复投递只应用一次：
   * 轮询与 hello 是两条并发的异步，谁先回来都可能；重复应用会把刚由宿主打开的
   * 文件又清掉。
   */
  const applyWorkspace = useCallback(
    (workspace: Workspace | null) => {
      const key = workspaceKey(workspace);
      if (key === appliedKeyRef.current) return;
      appliedKeyRef.current = key;
      workspaceRef.current = workspace;
      setRoot(workspace);
      resetExplorer();
      if (workspace) void loadRef.current("", true);
    },
    [resetExplorer],
  );

  applyRef.current = applyWorkspace;

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
    // 订阅工作区变化：组一变就整体重载（宿主没有给 workpanel 的工作区事件，
    // 只能靠 workspace.get 的轮询；判断键含组 id 与全部 root，见 lib/workspace.ts）。
    // 有未保存内容时先走守卫。
    // 依赖保持为空：watchWorkspace 订阅时会立刻发一次首次结果，若把 t 放进
    // 依赖，切换语言就会重订阅并再次触发「工作区变化」，把树和文件全清掉。
    return watchWorkspace((workspace) => {
      // 偏好（含 root 记忆）还没到手就先压着：基点是由记忆决定的，拿着空记忆
      // 去恢复会加载错目录、还会把用户的选择冲掉。hello 回来后由它放出去。
      if (!prefsLoadedRef.current) {
        pendingWorkspaceRef.current = workspace;
        return;
      }
      // 与 0.4.0 一致：换项目时若有未保存的改动，先问一句（换基点走的是另一个
      // 入口，它自己带守卫，见 switchRoot / applyHostOpen）。
      const apply = () => applyRef.current(workspace);
      const paths = documents.tabs.filter(tab => tab.dirty).map(tab => tab.file.path);
      if (paths.length) {
        pendingRef.current = apply;
        setGuard({ body: tRef.current("dirtyPromptBody", { name: paths.join(", ") }), paths });
        return;
      }
      apply();
    });
  }, []);

  useEffect(
    () =>
      watchHostOpenRequests((request) => {
        // 组与偏好还没到手：先排队。此时既不知道主根是谁，也判不出「组内绝对
        // 路径该落在哪个 root」——把它当项目外路径放行会绕过根内包含校验。
        // 放行在下面 ready 的 effect 里。
        if (!readyRef.current) {
          pendingHostOpenRef.current = request;
          return;
        }
        hostOpenRef.current(request);
      }),
    [],
  );

  // 首次加载：拿偏好、root 记忆与项目组。
  // 这一步必须是「应用项目组」的唯一发令枪之一（另一处是上面的轮询回调）：
  // 两条异步（workspace.get 与 fm.hello）谁先回来都可能，统一在这里收口。
  useEffect(() => {
    void (async () => {
      let workspace: Workspace | null = null;
      try {
        const hello = await invoke<HelloResponse>(channels.hello);
        if (hello?.ok) {
          setPrefs(hello.prefs);
          workspace = hello.root;
        }
      } catch {
        /* 偏好拿不到就按默认值继续：不能把视图卡在「没加载」上 */
      }
      prefsLoadedRef.current = true;

      const queued = pendingWorkspaceRef.current;
      pendingWorkspaceRef.current = undefined;
      // 轮询先回来的那份更权威（它就是 workspace.get 的原始结果）；它缺席时
      // 才用 hello 自己带的（组 + 主根 + 选中的 root 记忆）。
      const first = queued ?? workspace;
      applyRef.current(first);
      readyRef.current = true;
      setReady(true);
    })();
  }, []);

  /** Restore local capabilities after a remote startup; discard probes from an old workspace. */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const key = workspaceKey(root);
    const current = () => !cancelled && workspaceKey(workspaceRef.current) === key;
    setEditors(null);
    setWatchAvailable(false);
    setOpenHtmlInBrowserAvailable(false);
    if (!root || remoteReadOnly) return;
    void invoke<HelloResponse>(channels.hello).then((response) => {
      if (!current() || !response?.ok) return;
      setWatchAvailable(response.watch?.available === true);
      setOpenHtmlInBrowserAvailable(response.capabilities?.openHtmlInBrowser === true);
    }).catch(() => { /* Optional host capabilities remain unavailable. */ });
    void invoke<EditorsResponse>(channels.editors).then((response) => {
      if (current() && response?.ok) setEditors(response.editors);
    }).catch(() => { /* The default application remains available without detected editors. */ });
    return () => { cancelled = true; };
  }, [ready, root, remoteReadOnly]);

  // ready 之后才放行排队的宿主请求：这个 effect 在应用完项目组的那次渲染之后
  // 才跑，所以 applyHostOpen 读到的组、基点与偏好都是最新的。
  useEffect(() => {
    if (!ready) return;
    const pending = pendingHostOpenRef.current;
    pendingHostOpenRef.current = null;
    if (pending) hostOpenRef.current(pending);
  }, [ready]);

  // ── 目录操作 ─────────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string, force = false) => {
      const revision = revisionRef.current;
      const existing = dirsRef.current.get(path);
      if (!force && existing?.entries && !existing.loading) return existing.entries;
      const token = Symbol();
      directoryRequests.current.set(path, token);
      const current = () => revision === revisionRef.current && directoryRequests.current.get(path) === token;

      const setDir = (state: DirState) =>
        setDirectories((prev) => {
          const next = new Map(prev);
          next.set(path, state);
          return next;
        });

      if (!existing?.entries) setDir({ loading: true });
      try {
        const response = await invoke<ListResponse | Failure>(channels.list, { path, workspacePath: workspaceRef.current?.path });
        if (!current()) return revision === revisionRef.current && response.ok ? response.entries : undefined;
        if (!response.ok) {
          setDir({ error: failureMessage(response, t) });
          return;
        }
        setDir({ entries: response.entries });
        // 「项目里有没有忽略规则」只有根目录那次列表能回答，用来提示用户
        // 树里为什么少了一些条目（工具栏的眼睛按钮可以切回显示）。
        if (path === "") setIgnoreActive(response.ignoreActive);
        // 概览是整个工作区的（与列的是哪个目录无关），所以任何一次列表刷新都拿
        // 最新的一份回来；徽标已经随每条 entry 一起进来了。
        setGitSummary(response.git ?? null);
        return response.entries;
      } catch (cause) {
        if (!current()) return;
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
      if (!expanded.has(path)) void loadDirectory(path, true);
    },
    [expanded, loadDirectory],
  );

  const refreshTree = useCallback(() => {
    const revision = revisionRef.current;
    const open = [...expanded];
    void (async () => {
      await loadDirectory("", true);
      for (const path of open) {
        if (revision !== revisionRef.current) return;
        await loadDirectory(path, true);
      }
    })();
  }, [expanded, loadDirectory]);

  const collapseAll = () => {
    expandToken.current++;
    setExpanding(false);
    setExpanded(new Set());
  };
  const expandAll = async () => {
    const token = ++expandToken.current;
    setExpanding(true);
    const queue = [""];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length && token === expandToken.current;) {
      const batch = queue.slice(index, index + 4);
      index += batch.length;
      const listings = await Promise.all(batch.map(path => loadDirectory(path, true)));
      if (token !== expandToken.current) return;
      const children: string[] = [];
      for (const entries of listings) for (const e of entries ?? []) {
        if (!e.isDirectory || e.isSymlink || (!prefsRef.current.showIgnored && e.ignored) || seen.has(e.path)) continue;
        seen.add(e.path);
        children.push(e.path);
        queue.push(e.path);
      }
      if (children.length) setExpanded(prev => new Set([...prev, ...children]));
    }
    if (token === expandToken.current) setExpanding(false);
  };

  // ── 打开 / 保存 ──────────────────────────────────────────────────────────

  // Review tabs are independent of the editor buffer. Activating one cancels
  // a pending foreground open, but leaves the current file and draft intact.
  const cancelOpening = () => {
    if (!openingPath) return;
    ++openTokenRef.current;
    setOpeningPath(null);
  };
  const activateReview = (key: string) => {
    cancelOpening();
    dispatchReview({ type: "activate", key });
  };
  const openReview = (tab: ReviewTab) => {
    cancelOpening();
    dispatchReview({ type: "open", tab });
  };
  const openDiff = (path: string) => {
    if (!path || isExternalPath(path)) return;
    const existing = review.tabs.find(tab => tab.kind === "diff" && tab.path === path);
    if (existing) activateReview(reviewKey(existing));
    else openReview({ kind: "diff", panel: false, path, scope: "worktree" });
  };
  const focusActiveTab = () => requestAnimationFrame(() => {
    const next = stripRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    (next ?? document.getElementById(segmentId("fm-sidebar", view)))?.focus({ preventScroll: true });
  });
  const closeReview = (key: string) => {
    dispatchReview({ type: "close", key });
    focusActiveTab();
  };

  /**
   * 打开一个路径。只要 path：宿主请求打开的可能是项目之外的绝对路径（会话
   * 临时目录 / 附件），它没有对应的树条目。
   */
  const captureTab = useCallback(() => {
    const tab = documents.active;
    if (tab?.file.kind === 'text' && handleRef.current) tab.editor = handleRef.current.capture();
  }, [documents]);

  const openEntry = useCallback(
    async (entry: { path: string }, fromWatch = false, reload = false) => {
      if (!fromWatch) dispatchReview({ type: "document" });
      const token = fromWatch ? openTokenRef.current : ++openTokenRef.current;
      const readToken = ++watchReadToken.current;
      const current = () => token === openTokenRef.current && (!fromWatch || (readToken === watchReadToken.current && documents.active?.file.path === entry.path));
      // 项目外路径不在树里：选中态置空，免得高亮到一条无关的行。
      const external = isExternalPath(entry.path);
      if (!fromWatch) { setSelected(external ? null : entry.path); setError(null); }
      const cached = documents.get(entry.path);
      if (!fromWatch) setOpeningPath(!cached ? entry.path : null);
      if (!fromWatch && !reload && cached) {
        if (documents.active !== cached) { captureTab(); documents.activate(entry.path); }
        const disk = dirsRef.current.get(parentOf(entry.path))?.entries?.find(e => e.path === entry.path);
        if (disk && disk.mtimeMs > cached.file.mtimeMs + 0.5) documents.patch(entry.path, { changed: true });
        if (!cached.changed || cached.dirty) return;
      }
      try {
        const request: ReadRequest = external
          ? { path: entry.path, external: true }
          : { path: entry.path };
        const response = await invoke<ReadResponse | Failure>(channels.read, { ...request, workspacePath: workspaceRef.current?.path });
        if (!current()) return;
        if ((fromWatch || cached?.changed) && !reload && documents.get(entry.path)?.dirty) { documents.patch(entry.path, { changed: true }); return; }
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        loadTokenRef.current += 1;
        if (documents.active?.file.path !== entry.path) captureTab();
        const file = toOpenFile(response, loadTokenRef.current);
        documents.load(file);
        const mode = resolveViewer(file.path, prefsRef.current)?.mode;
        if (mode && !documents.active?.mode) documents.patch(file.path, { mode });
      } catch (cause) {
        if (!current()) return;
        setError(String((cause as Error).message));
      } finally {
        if (!fromWatch && current()) setOpeningPath(null);
      }
    },
    [captureTab, documents, t],
  );


  useTreeWatch(!remoteReadOnly && prefs.watchFiles ? activeRoot?.path ?? null : null, {
    visible: () => ["", ...(sidebarOpen && view === "files" ? [...expanded].filter(dir => ancestorPaths(dir).every(parent => expanded.has(parent))) : [])],
    refresh: dir => loadDirectory(dir, true),
    onPaths: (paths, stale) => {
      documents.noteChanges(paths, stale);
      refreshChangesRef.current();
    },
    document: () => ({ openPath: openPathRef.current, dirty: dirtyRef.current }),
    onDocument: (path, warn) => {
      if (isExternalPath(path)) return;
      documents.patch(path, { changed: true });
      if (!warn) void openEntry({ path }, true);
    },
    onAvailable: setWatchAvailable,
  });

  const withGuard = useCallback(
    (action: () => void, all = false) => {
      const targets = all ? documents.tabs.filter(tab => tab.dirty) : documents.active?.dirty ? [documents.active] : [];
      if (!targets.length) {
        action();
        return;
      }
      pendingRef.current = action;
      const paths = targets.map(tab => tab.file.path);
      setGuard({ body: t("dirtyPromptBody", { name: paths.join(', ') }), paths });
    },
    [documents, t],
  );

  const requestOpen = useCallback(
    (entry: FileEntry) => { void openEntry(entry); },
    [openEntry],
  );

  const closeTab = (path: string) => {
    const tab = documents.get(path);
    if (!tab || saving) return;
    const close = () => {
      const wasActive = documents.active === tab;
      ++openTokenRef.current;
      setOpeningPath(null);
      documents.remove(path);
      if (wasActive) {
        setError(null);
        const next = documents.active?.file.path;
        setSelected(next && !isExternalPath(next) ? next : null);
        if (next && documents.active?.changed && !documents.active.dirty) void openEntry({ path: next }, true);
        if (!next && !activeReview) {
          const fallback = review.tabs[review.tabs.length - 1];
          if (fallback) dispatchReview({ type: "activate", key: reviewKey(fallback) });
        }
      }
      focusActiveTab();
    };
    if (!tab.dirty) { close(); return; }
    pendingRef.current = close;
    setGuard({ body: t('closeDirtyFile', { name: path }), paths: [path] });
  };

  const persistPrefs = useCallback((partial: Partial<Prefs>) => {
    setPrefs((prev) => ({ ...prev, ...partial }));
    void invoke(channels.prefsSet, { partial }).catch(() => {});
  }, []);

  // ── 项目组：切换正在浏览的 folder root ───────────────────────────────────

  /**
   * 换基点。落盘必须**等它写完**再往下走：包含基点是从 prefs.projectRoots 推导出
   * 来的（main.js 的 selectedRootOf），写没到，下一个通道请求就会按旧基点解析。
   * 落盘失败就什么都不换——宁可让这次切换失败，也不能让树和包含基点各说各话。
   */
  const activateRoot = useCallback(
    async (target: WorkspaceRoot): Promise<boolean> => {
      const workspace = rootRef.current;
      if (!workspace) return false;
      const revision = revisionRef.current;
      const memory = rememberProjectRoot(
        prefsRef.current.projectRoots,
        projectKeyOf(workspace),
        target.path,
      );
      const response = await invoke<PrefsResponse>(channels.prefsSet, {
        partial: { projectRoots: memory },
      }).catch(() => null);
      if (revision !== revisionRef.current) return false;
      if (!response || !response.ok) {
        setError(tRef.current("switchFailed"));
        return false;
      }
      setPrefs((prev) => ({ ...prev, projectRoots: memory }));
      resetExplorer();
      await loadRef.current("", true);
      return true;
    },
    [resetExplorer],
  );

  /** 切换器里点了一个 folder：照旧先过脏缓冲守卫，取消就什么都不改。 */
  const switchRoot = (target: WorkspaceRoot) => {
    if (!activeRoot || samePath(activeRoot.path, target.path)) return;
    withGuard(() => void activateRoot(target), true);
  };

  /** 菜单锚在控件下方；ContextMenu 自己会按视口夹取，靠边也不会跑出去。 */
  const openRootMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (armedRef.current) {
      armedRef.current = false;
      setRootMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setRootMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  /** 关菜单，并把手柄交回按钮——Escape 之后键盘还能接着用。 */
  const closeRootMenu = () => {
    armedRef.current = false;
    setRootMenu(null);
    rootButtonRef.current?.focus();
  };

  /** 组的文件夹列表：主根标出「主文件夹」，当前在看的那个打勾。 */
  const rootMenuEntries = (): MenuEntry[] =>
    roots.map((entry) => ({
      kind: "item",
      label: entry.name,
      hint: entry.primary ? t("primaryRoot") : undefined,
      icon: activeRoot && samePath(entry.path, activeRoot.path) ? <CheckGlyph /> : undefined,
      onPick: () => switchRoot(entry),
    }));

  /**
   * 宿主要求打开的文件：两条投递路径（入口查询串 / view:open 推送）最终都落到
   * 这里。三种路径形态各有各的基准（0.5.0）：
   *   项目内相对路径 → 基准是**主根**；当前看的不是主根就先切回主根再打开。
   *   组内绝对路径   → 切到包含它的那个 root，再按「相对那个 root」打开（祖先
   *                    目录照旧展开、行照旧高亮，与点击搜索结果一致）。
   *   组外绝对路径   → 0.4.0 的外部行为：不进树、不高亮、基点不动。
   * 换基点必须先落盘（见 activateRoot）——包含基点由 prefs.projectRoots 推导。
   * 视觉结果与在树里点这个文件一致，因此复用 openEntry 与它的脏缓冲守卫；宿主
   * 请求一律把左侧列表收起并持久化，用户之后重新展开会一直保持到下一次宿主请求。
   */
  const applyHostOpen = useCallback(
    (request: HostOpenRequest) => {
      const requestedWorkspace = workspaceKey(workspaceRef.current);
      setView("files");
      dispatchReview({ type: "document" });
      const rawPath = request.path;
      const absolute = isExternalPath(rawPath);
      // 组的 root 列表还没到手时（ready 之前）这个请求会被排队，见下面 ready 的 effect。
      const contained = absolute ? findRootForPath(roots, rawPath) : null;
      const base = contained ? contained.root : absolute ? null : primaryRootOf(roots);
      const relPath = contained ? contained.rel : rawPath;

      persistPrefs({ treeCollapsed: true });

      const show = () => {
        if (workspaceKey(workspaceRef.current) !== requestedWorkspace) return;
        const revision = revisionRef.current;
        // 已经是这个文件：不重装文档，也就不必为脏缓冲再问一遍。
        if (relPath === openPathRef.current) return;
        // 组外的绝对路径不在树里：不展开、也不高亮（openEntry 会把选中态置空）。
        if (!contained && absolute) {
          void openEntry({ path: relPath });
          return;
        }
        // 项目内路径：展开并加载祖先目录，与搜索命中的跳转是同一套做法。
        const parents = ancestorPaths(relPath);
        setSelected(relPath);
        setExpanded((prev) => new Set([...prev, ...parents]));
        void (async () => {
          for (const parent of parents) {
            if (revision !== revisionRef.current) return;
            await loadDirectory(parent);
          }
          if (revision !== revisionRef.current) return;
          await openEntry({ path: relPath });
        })();
      };

      // 基点没变（也包括「没有项目」与组外路径）：直接开，脏缓冲守卫照旧。
      if (!base || samePath(activeRootRef.current?.path ?? "", base.path)) {
        show();
        return;
      }
      // 要先换基点：换成功再打开；守卫被取消的话基点也不动。
      withGuard(() => {
        void activateRoot(base).then((ok) => {
          if (ok) show();
        });
      }, true);
    },
    [activateRoot, loadDirectory, openEntry, persistPrefs, roots, withGuard],
  );

  hostOpenRef.current = applyHostOpen;

  const save = useCallback(
    async (override?: { mtimeMs: number; size: number }, path = documents.active?.file.path): Promise<boolean> => {
      const tab = path ? documents.get(path) : undefined;
      if (!tab || tab.file.kind !== 'text' || tab.file.readOnly) return false;
      // 没有改动就不写盘：Ctrl+S 是习惯动作，不该白抬一次 mtime、白记一行审计，
      // 更不该因为文件在别处被改过而弹出一个「冲突」。带 override 的是冲突框里的
      // 「覆盖」，那是显式意图，照写。
      if (!override && !tab.dirty) return false;
      if (inFlightRef.current) return inFlightRef.current.path === path ? inFlightRef.current.promise : false;
      const target = tab.file, revision = revisionRef.current;
      const tabText = () => documents.active === tab ? handleRef.current?.text() ?? target.text : tab.editor?.state.doc.toString() ?? target.text;
      const text = tabText();

      const run = (async (): Promise<boolean> => {
        setSaving(true);
        setError(null);
        try {
          const external = isExternalPath(target.path);
          const request: WriteRequest = {
            path: target.path,
            text,
            expectedMtimeMs: override?.mtimeMs ?? target.mtimeMs,
            expectedSize: override?.size ?? target.size,
            eol: target.eol,
            bom: target.bom,
            // 宿主请求打开的项目外文件：显式声明，主进程只查黑名单，不再要求
            // 路径落在项目根内。
            ...(external ? { external: true } : {}),
          };
          const response = await invoke<WriteResponse>(channels.write, { ...request, workspacePath: workspaceRef.current?.path, expectedRoot: activeRootRef.current?.path });

          // 写是成功了，但用户可能已经切走——那就只认这次写的成功，别把
          // 元数据、脏标记、冲突框落到另一个文件上。
          if (revisionRef.current !== revision || documents.get(target.path) !== tab) return false;

          if (response.ok) {
            // 只更新元数据（下一次乐观锁的期望值）与文本，loadToken 不动：
            // 编辑器里的文档就是刚存下去的那份，不该被重装。
            documents.patch(target.path, { file: withSavedContent(target, response, text), dirty: tabText() !== text, changed: false });
            // 项目外的文件没有对应的树目录要刷新。
            if (!external) void loadDirectory(parentOf(target.path), true);
            if (!external) refreshChangesRef.current();
            return !tab.dirty;
          }
          if (isConflict(response)) {
            setConflict({ path: target.path, mtimeMs: response.mtimeMs, size: response.size });
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
    [loadDirectory, documents, t],
  );

  saveRef.current = activeReview || openingPath ? null : save;

  // Ctrl/Cmd+S 在编辑器之外也得能用：点了工具栏按钮、或正停在预览 / 表格 / 树
  // 视图时，焦点不在 CodeMirror 里，编辑器自己的键位收不到这个键。编辑器内部的
  // 绑定保留——它先跑并 preventDefault，这里据此跳过，不会保存两次。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      void saveRef.current?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reloadFromDisk = useCallback(() => {
    if (!openFile) return;
    withGuard(() => void openEntry({ path: openFile.path }, false, true));
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
    searchTokenRef.current++;
    setSearch({ hits: [], running: true, done: false });
    const timer = window.setTimeout(() => void runSearch(query), 220);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  const sidebar = useSidebarSize(bodyRef, prefs.sidebarWidth, prefs.splitRatio, width => persistPrefs({ sidebarWidth: width }));
  const repoContext = useMemo<RepoContext | null>(() => root && activeRoot && !remoteReadOnly ? {
    workspacePath: root.path, rootPath: activeRoot.path, projectId: root.projectId,
  } : null, [root, activeRoot?.path, remoteReadOnly]);
  const git = useGitWorkspace(repoContext, (sidebarOpen && view === "git") || (activeReview?.kind === "diff" && activeReview.panel), () => refreshTree());
  refreshChangesRef.current = git.refreshChanges;
  const refreshGit = git.refresh;
  const syncInfo = git.info;

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
        refreshChangesRef.current();
        await loadDirectory(active.parent, true);
        if (active.parent) setExpanded((prev) => new Set(prev).add(active.parent));
      } else if (active.kind === "rename") {
        const response = await invoke<{ ok: true; entry: FileEntry } | Failure>(channels.rename, {
          path: active.entry.path,
          newName: value,
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        documents.move(active.entry.path, response.entry.path);
        refreshChangesRef.current();
        await loadDirectory(parentOf(active.entry.path), true);
        setSelected((prev) => (prev === active.entry.path ? null : prev));
      }
    } catch (cause) {
      setError(String((cause as Error).message));
    }
  };
  const runDelete = useCallback(
    async (entry: FileEntry) => {
      const external = isExternalPath(entry.path);
      try {
        const response = await invoke<DeleteResponse | Failure>(channels.delete, {
          path: entry.path,
          // 项目外路径要显式声明：主进程只查黑名单，不再要求落在项目根内。
          ...(external ? { external: true } : {}),
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        // 项目外路径没有树目录可刷新，也不参与选中态。
        if (!external) await loadDirectory(parentOf(entry.path), true);
        setSelected((prev) => (prev === entry.path ? null : prev));
        // 删的正是当前打开的文件：编辑器里那份内容已经没有对应的磁盘文件了。
        const within = (p: string) => p === entry.path || p.startsWith(entry.path + '/');
        for (const tab of documents.tabs) if (within(tab.file.path)) documents.remove(tab.file.path);
        if (!external) refreshChangesRef.current();
      } catch (cause) {
        setError(String((cause as Error).message));
      }
    },
    [loadDirectory, t],
  );

  const moveEntry = async (entry: FileEntry, toDir: string) => {
    if (remoteReadOnly || inFlightRef.current) return;
    const revision = revisionRef.current;
    try {
      const result = await invoke<{ ok: true; entry: FileEntry | null } | Failure>(channels.move, {
        from: entry.path, toDir, workspacePath: workspaceRef.current?.path, expectedRoot: activeRoot?.path,
      });
      if (revision !== revisionRef.current) return;
      if (!result.ok) { setError(failureMessage(result, t)); return; }
      if (!result.entry) return;
      const dest = result.entry.path;
      const within = (path: string) => path === entry.path || path.startsWith(entry.path + "/");
      documents.move(entry.path, dest);
      refreshChangesRef.current();
      setSelected(dest);
      expandToken.current++;
      setExpanding(false);
      setExpanded(prev => new Set([...prev].filter(path => !within(path)).concat(ancestorPaths(dest))));
      setDirectories(prev => new Map([...prev].filter(([path]) => !within(path))));
      await Promise.all([loadDirectory(parentOf(entry.path), true), loadDirectory(toDir, true)]);
    } catch (cause) { if (revision === revisionRef.current) setError(String((cause as Error).message)); }
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
   * 默认应用、内置 Browser 与文件夹显示由宿主执行，受 manifest.fs.read 范围约束。
   * 失败走 toast 而不是插件的错误横幅——这些动作与当前打开的文件无关。
   */
  const runHostAction = useCallback((action: "open" | "browser" | "reveal", path: string) => {
    const run = action === "open"
      ? openWithDefaultApp
      : action === "browser"
        ? openInBuiltInBrowser
        : revealInFileManager;
    void run(path).catch(() => {
      void invoke("ui.showToast", {
        message: tRef.current(
          action === "open" ? "openError" : action === "browser" ? "openInBuiltInBrowserError" : "revealError",
        ),
      }).catch(() => {});
    });
  }, []);

  /**
   * 复制一段路径到剪贴板。成功与失败都给 toast：这是「点了应该有反应」的动作，
   * 静默失败会让人以为系统剪贴板坏了。文案里带上复制的内容，方便自证。
   */
  const copyPath = useCallback(async (value: string) => {
    const ok = await copyText(value);
    void invoke("ui.showToast", {
      message: ok
        ? tRef.current("pathCopied", { path: value })
        : tRef.current("copyFailed"),
    }).catch(() => {});
  }, []);

  /**
   * 「通过…打开」：路径与编辑器 id 一起交给插件主进程，它按同一套根内包含与凭据
   * 黑名单解析路径，并且只认自己探测出来的编辑器 id。
   */
  const runOpenWith = useCallback((path: string, id: string) => {
    void openWithEditor(path, id).catch(() => {
      void invoke("ui.showToast", { message: tRef.current("openWithFailed") }).catch(() => {});
    });
  }, []);

  /**
   * 「通过…打开」二级菜单的内容。
   *
   * HTML、HTM、XHTML 且宿主支持时，内置 Browser 项排在最前并与外部程序分隔；
   * 后面固定是系统默认应用（走宿主的 fs.openDefault）和主进程探测到的程序，按
   * 条目过滤（lib/editors.ts）：编辑器什么都能打开，外部浏览器只对网页文件出现。
   * 拿 Chrome 打开 App.tsx 只会看到一个纯文本加载页，那是把噪音摆进菜单。
   *
   * 过滤后一个都不剩（例如 .ts 文件上只装了浏览器）时只留默认应用那一项，不摆点了
   * 没反应的条目。目录允许交给编辑器（编辑器自己决定是打开目录还是文件），但
   * 内置 Browser 与「系统默认应用」都只接受文件。
   */
  const openWithEntries = (target: FileEntry | null): MenuEntry[] => {
    if (!target) {
      return [{ kind: "item", label: t("openWithEmpty"), disabled: true, onPick: () => {} }];
    }
    const absolute = absoluteFullPath(target.path, activeRootRef.current);
    const items: MenuEntry[] = [
      {
        kind: "item",
        label: t("openWithDefault"),
        disabled: target.isDirectory,
        onPick: () => runHostAction("open", hostActionPath(target.path, activeRootRef.current)),
      },
    ];
    const applicable = editorsFor(editors, target);
    for (const editor of applicable) {
      items.push({
        kind: "item",
        label: editor.label,
        onPick: () => runOpenWith(absolute, editor.id),
      });
    }
    // 探到一个程序都没有 vs 探到了但对这个文件不适用：前者值得说一句「没找到」，
    // 后者只是这个文件没有额外选项，默认应用已经够用，不再多摆一行。
    if ((editors ?? []).length === 0) {
      items.push({ kind: "item", label: t("openWithEmpty"), disabled: true, onPick: () => {} });
    }
    return withBuiltInBrowserEntry(
      target,
      openHtmlInBrowserAvailable,
      t("openInBuiltInBrowser"),
      items,
      (entry) => runHostAction("browser", hostActionPath(entry.path, activeRootRef.current)),
    );
  };

  // 结构化视图（Markdown 预览 / 表格 / 树）只对文本文件成立；具体有哪几种、
  // 默认落在哪一侧，全部由 lib/viewers.ts 一处判定，偏好决定默认值。
  const viewer = openFile && openFile.kind === "text" ? resolveViewer(openFile.path, prefs) : null;
  if (viewer && documents.active?.mode && viewer.modes.includes(documents.active.mode)) viewer.mode = documents.active.mode;
  /**
   * 当前打开文件的 git 状态。fm.read 打开那一刻就带回来了（左侧列表收起时也只有
   * 这一条路）；打开之后才发生的改动——用户自己刚存过一次——由树里的徽标补上，
   * 否则「保存之后右侧的『变更』按钮凭空消失」。
   */
  const listedOpenFile = openFile && directories.get(parentOf(openFile.path))?.entries?.find(e => e.path === openFile.path);
  const openFileGit = listedOpenFile ? listedOpenFile.git : openFile?.git ?? null;

  const changeViewerMode = (mode: ViewerMode) => {
    if (!viewer) return;
    if (openFile) documents.patch(openFile.path, { mode });
    if (viewer.modes.includes("markdown")) persistPrefs({ mdPreview: mode === "markdown" });
    else if (viewer.modes.includes("table")) persistPrefs({ csvTable: mode === "table" });
    else if (viewer.modes.includes("tree")) persistPrefs({ jsonTree: mode === "tree" });
  };

  const menuEntries = (): MenuEntry[] => {
    const target = menu?.entry ?? null;
    return buildFileContextMenuEntries({
      readOnly: remoteReadOnly,
      target,
      labels: {
        newFile: t("newFile"),
        newFolder: t("newFolder"),
        rename: t("rename"),
        delete: t("delete"),
        copyPath: t("copyPath"),
        copyRelativePath: t("copyRelativePath"),
        copyAbsolutePath: t("copyAbsolutePath"),
        openWithSubmenu: t("openWithSubmenu"),
        viewChanges: t("viewChanges"),
        revealInFolder: t("revealInFolder"),
        refresh: t("refresh"),
      },
      openWithEntries: target ? openWithEntries(target) : [],
      onNewFile: (parent) => setPrompt({ kind: "newFile", parent }),
      onNewFolder: (parent) => setPrompt({ kind: "newFolder", parent }),
      onRename: (entry) => setPrompt({ kind: "rename", entry }),
      onDelete: (entry) => {
        setSelected(entry.path);
        setConfirmDelete({ entry });
      },
      onCopyRelativePath: (entry) => void copyPath(entry.path),
      onCopyAbsolutePath: (entry) =>
        void copyPath(absoluteFullPath(entry.path, root?.remote && activeRootRef.current
          ? { ...activeRootRef.current, path: root.remote.path } : activeRootRef.current)),
      onViewChanges: (entry) => { setMenu(null); openDiff(entry.path); },
      onRevealInFolder: (entry) =>
        runHostAction("reveal", hostActionPath(entry.path, activeRootRef.current)),
      onRefresh: (directory) => void loadDirectory(directory, true),
    });
  };

  // ── 视图切换 ─────────────────────────────────────────────────────────────

  const showView = useCallback((next: SidebarView, toggle = false) => {
    const collapsed = prefsRef.current.treeCollapsed;
    if (toggle && !collapsed && view === next) {
      persistPrefs({ treeCollapsed: true });
      return;
    }
    if (collapsed) persistPrefs({ treeCollapsed: false });
    if (next === "git" && (collapsed || view !== "git")) refreshGit();
    setView(next);
  }, [persistPrefs, refreshGit, view]);

  const onWorkbenchKey = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.repeat || event.nativeEvent.isComposing || guard || prompt || conflict || confirmDelete) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && (key === "e" || key === "f" || key === "g")) {
      event.preventDefault();
      const next = key === "e" ? "files" : key === "f" ? "search" : "git";
      showView(next);
      requestAnimationFrame(() => {
        if (next === "search") searchInput.current?.focus();
        else document.getElementById(segmentId("fm-sidebar", next))?.focus();
      });
    } else if (!event.shiftKey && key === "b") {
      event.preventDefault();
      persistPrefs({ treeCollapsed: sidebarOpen });
      if (sidebarOpen && (event.target instanceof Element) && event.target.closest("#fm-sidebar, .fm-gutter")) {
        document.getElementById(segmentId("fm-sidebar", view))?.focus();
      }
    } else if (!event.shiftKey && key === "w" && (activeReview || openFile)) {
      event.preventDefault();
      if (activeReview) closeReview(reviewKey(activeReview));
      else if (openFile) closeTab(openFile.path);
    }
  };

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  const searchActive = query.trim().length > 0;
  const documentTabs = documents.tabs;
  const fileTabId = (path: string) => segmentId("fm-content-panel", `file-${encodeURIComponent(path)}`);
  const reviewTabId = (key: string) => segmentId("fm-content-panel", encodeURIComponent(key));
  const activeTabId = activeReview ? reviewTabId(reviewKey(activeReview)) : openFile ? fileTabId(openFile.path) : undefined;
  useEffect(() => {
    stripRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);
  const nameCounts = new Map<string, number>();
  for (const { file } of documentTabs) {
    const name = baseNameOf(file.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const activeDiff = activeReview?.kind === "diff" ? activeReview : null;
  const activeCommit = activeReview?.kind === "commit" ? activeReview.commit : null;
  const diffEntry = activeDiff?.panel ? git.snapshot?.entries.find(entry => entry.path === activeDiff.path) : undefined;
  const diffScope = activeDiff ? scopeFor(diffEntry, activeDiff.scope) : "worktree";
  const diffFailure = git.changesError ?? (!git.changesSupported && git.infoReady ? git.infoError : null);
  const diffUnavailable = activeDiff?.panel && (diffFailure || (git.infoReady && !git.changesSupported))
    ? (diffFailure ? gitOperationError(diffFailure, t) : t("gitUnavailable")) : undefined;
  const documentVisible = !activeReview && !openingPath;
  const sourceVisible = documentVisible && openFile?.kind === "text" && (!viewer || viewer.mode === "source");
  const wrapLines = prefs.wrapLines !== false;
  const relatedDiff = activeDiff?.path === openFile?.path && !!activeDiff;
  const options = openFile && (documentVisible || relatedDiff) && openFile.kind === "text" ?
    paneTabs({ modes: viewer?.modes ?? null, hasGit: !!openFileGit || relatedDiff, isText: true }) : [];
  const viewMode = relatedDiff ? "diff" : viewer?.mode ?? "source";
  const fileRoot = root?.remote && activeRoot ? { ...activeRoot, path: root.remote.path } : activeRoot;
  const displayFilePath = openFile ? (isExternalPath(openFile.path) ? openFile.path : absolutePathOf(openFile.path, fileRoot)) : "";
  const documentKind = contentKind({ fileKind: openFile?.kind ?? null, viewerMode: viewer?.mode ?? "source", diffOpen: false });
  const kind = activeCommit ? t("commitDetail") : activeDiff ? t("changes") : openingPath ? t("loading") : openFile ? t({
    editor: "statusSource", markdown: "previewMode", table: "tableMode", tree: "treeMode", image: "statusImage", media: "statusMedia",
    pdf: "pdfTitle", sqlite: "sqliteTitle", binary: "statusBinary", tooLarge: "statusBinary", diff: "changes",
  }[documentKind] as Parameters<T>[0]) : null;
  const syncOutcome = git.outcome?.operation === "sync" ? git.outcome : null;
  const hiddenGitError = (view !== "git" || !sidebarOpen) ? git.outcome?.error : null;
  const globalError = error ?? ((syncOutcome?.error ?? hiddenGitError) ? gitOperationError((syncOutcome?.error ?? hiddenGitError)!, t) : null);

  /**
   * 新建文件 / 文件夹落在哪：有选中目录就是它，选中的是文件就落在它所在的目录，
   * 什么都没选就落在根。与右键菜单里的做法一致，只是头部按钮需要一个默认值。
   */
  const selectedDirectory = useMemo(() => {
    if (!selected) return "";
    const entry = directories.get(parentOf(selected))?.entries?.find(e => e.path === selected);
    if (entry?.isDirectory) return selected;
    return parentOf(selected);
  }, [directories, selected]);

  /**
   * 点搜索结果：逐级展开并加载祖先目录，然后打开它。与树里点同一个文件后
   * 的视觉结果一致（展开、高亮、内容区装载），只是入口不同。
   */
  const openHit = (hit: SearchHit) => {
    const revision = revisionRef.current;
    setView("files");
    setFilter("");
    const parents = ancestorPaths(hit.path);
    setExpanded(prev => new Set([...prev, ...parents, ...(hit.isDirectory ? [hit.path] : [])]));
    setSelected(hit.path);
    if (!hit.isDirectory) void openEntry({ path: hit.path });
    void (async () => {
      for (const parent of [...parents, ...(hit.isDirectory ? [hit.path] : [])]) {
        if (revision !== revisionRef.current) return;
        await loadDirectory(parent);
      }
    })();
  };

  return (
    <div className="fm-app" onKeyDown={onWorkbenchKey}>
      <header className="fm-topbar">
        <span className="fm-brand">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h6l2 2h10v12H3z" />
          </svg>
          {t("title")}
        </span>

        {switchable ? (
          /* 组的文件夹多于一个：这个名字本身就是切换器。菜单复用 ContextMenu
             （Escape 与点到外面都会关、↑↓ / Home / End 可用），按钮自己提供
             aria-haspopup / aria-expanded 与可读名字。 */
          <button
            ref={rootButtonRef}
            type="button"
            className="fm-rootchip"
            aria-haspopup="menu"
            aria-expanded={rootMenu !== null}
            aria-label={t("switchFolderNamed", { name: headerName, count: rootCount })}
            title={t("switchFolder")}
            onMouseDown={() => { armedRef.current = rootMenu !== null; }}
            onClick={openRootMenu}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h6l2 2h10v12H3z" />
            </svg>
            <span className="fm-rootchip-name">{headerName}</span>
            <span className="fm-rootchip-hint">{root?.name && root.name !== headerName ? root.name : ""}</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        ) : (
          <span className="fm-rootchip" data-static="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h6l2 2h10v12H3z" />
            </svg>
            <span className="fm-rootchip-name">{root?.name ?? t("title")}</span>
          </span>
        )}

        {remoteReadOnly ? <span className="fm-topbar-note" role="status">{t("remoteReadOnly")}</span> : null}

        {syncInfo?.state === "repository" && (
          <GitSync key={repoContext?.rootPath} info={syncInfo} t={t} disabled={!git.infoReady || !!git.operation}
            busy={git.operation === "sync"} onRun={git.sync} />
        )}

        <span className="fm-topbar-grow" />
        <div className="fm-topbar-tools">

        <IconButton
          label={prefs.showIgnored ? t("hideIgnored") : t("showIgnored")}
          active={prefs.showIgnored}
          disabled={remoteReadOnly}
          onClick={() => persistPrefs({ showIgnored: !prefs.showIgnored })}
        >
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </IconButton>
        <IconButton
          label={remoteReadOnly ? t("remoteReadOnly") : !watchAvailable && prefs.watchFiles ? t("watchFallback") : prefs.watchFiles ? t("watchOn") : t("watchOff")}
          active={prefs.watchFiles && !remoteReadOnly}
          disabled={remoteReadOnly}
          onClick={() => persistPrefs({ watchFiles: !prefs.watchFiles })}
        >
          <path d="M4.5 11a7.5 7.5 0 1 1 1.8 6M4 6v5h5M12 8v4l3 2" />
        </IconButton>
        {/*
          Wrap and theme are view preferences, not file actions, so they sit at
          the far right after the toggles that change *what* is listed. Wrap is
          only meaningful for the code view, hence the disabled state elsewhere.
        */}
        <IconButton
          label={wrapLines ? t("wrapOff") : t("wrapOn")}
          active={wrapLines}
          disabled={!sourceVisible}
          onClick={() => persistPrefs({ wrapLines: !wrapLines })}
        >
          <path d="M4 6h16M4 12h11a3 3 0 1 1 0 6h-3l2-2m-2 2 2 2M4 18h4" />
        </IconButton>
        <IconButton label={t("refresh")} onClick={() => { refreshTree(); git.refresh(); }}>
          <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
          <path d="M3 4v5h5" />
          <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
          <path d="M21 20v-5h-5" />
        </IconButton>
        {/*
          Light/dark follows the host, but a manual override is sometimes the only
          way to read a diff: this only flips the local palette (`data-base`),
          which every rule in this stylesheet is written against.
        */}
        <IconButton
          label={base === "dark" ? t("themeLight") : t("themeDark")}
          onClick={() => {
            const next = base === "dark" ? "light" : "dark";
            setBase(next);
            applyBase(next);
          }}
        >
          {base === "dark"
            ? <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
            : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
        </IconButton>
        </div>
      </header>
      {globalError && <div className="fm-workbench-alert" role="alert">{globalError}</div>}

      <div ref={bodyRef} className="fm-body" data-resizing={sidebar.dragging || undefined}>
        <ActivityRail
          view={view}
          onView={showView}
          hidden={!sidebarOpen}
          badge={git.changesReady && git.snapshot ? git.snapshot.entries.length : gitSummary?.total ?? 0}
          label={t("workbenchViews")}
          labels={{ files: t("viewFiles"), search: t("viewSearch"), git: t("viewGit") }}
        >
          <button
            type="button"
            className="fm-rail-btn"
            aria-expanded={sidebarOpen}
            aria-controls="fm-sidebar"
            aria-label={t("toggleSidebar")}
            title={`${t("toggleSidebar")} · Ctrl+B`}
            onClick={() => persistPrefs({ treeCollapsed: !prefs.treeCollapsed })}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </ActivityRail>

        <aside
          id="fm-sidebar" className="fm-sidebar" role="tabpanel" hidden={!sidebarOpen}
          style={{ width: sidebar.width }} aria-labelledby={segmentId("fm-sidebar", view)}
        >
          {sidebarOpen ? (
            <>
              {/*
                One header per view: an uppercase title (which view am I in) and
                the actions that belong to it. The body below is the only thing
                that swaps, so the header row never jumps.
              */}
              <div className="fm-side-head">
                <span className="fm-side-title">{view === "git" ? t("sourceControl") : view === "search" ? t("viewSearch") : t("explorer")}</span>
                {view === "files" ? (
                  <span className="fm-side-actions">
                    <IconButton small label={remoteReadOnly ? t("remoteReadOnly") : t("newFile")} disabled={remoteReadOnly}
                      onClick={() => setPrompt({ kind: "newFile", parent: selectedDirectory })}>
                      <path d="M6 3h8l4 4v14H6z" /><path d="M12 11v6M9 14h6" />
                    </IconButton>
                    <IconButton small label={remoteReadOnly ? t("remoteReadOnly") : t("newFolder")} disabled={remoteReadOnly}
                      onClick={() => setPrompt({ kind: "newFolder", parent: selectedDirectory })}>
                      <path d="M3 6h6l2 2h10v12H3z" /><path d="M12 12v5M9.5 14.5h5" />
                    </IconButton>
                    <IconButton small label={t("collapseAll")} disabled={!expanded.size} onClick={collapseAll}>
                      <path d="M4 8h16M4 16h16" />
                    </IconButton>
                  </span>
                ) : null}
                {view === "git" && repoContext && (
                  <span className="fm-side-actions">
                    <IconButton small label={t("refresh")} disabled={!!git.operation} onClick={() => { refreshTree(); git.refresh(); }}>
                      <GitIconPath name="refresh" />
                    </IconButton>
                  </span>
                )}
              </div>

              {view === "git" ? (
                <div className="fm-side-body fm-side-body-flush">
                  {repoContext ? <GitPanel git={git} context={repoContext} segment={gitSegment} onSegment={setGitSegment}
                    selection={activeDiff && { path: activeDiff.path, scope: diffScope }} inspected={activeCommit} locale={hostLocale} t={t}
                    onInspect={commit => openReview({ kind: "commit", commit })}
                    onSelect={item => openReview({ kind: "diff", panel: true, ...item })} /> :
                    <p className="scm-guide">{t(remoteReadOnly ? "remoteReadOnly" : "noWorkspaceTitle")}</p>}
                </div>
              ) : view === "search" ? (
                <div className="fm-side-body">
                  <div className="fm-search">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
                    </svg>
                    <input
                      ref={searchInput}
                      value={query}
                      disabled={remoteReadOnly}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                      placeholder={t("searchPlaceholder")}
                      aria-label={t("search")}
                    />
                    {query ? <button type="button" aria-label={t("clear")} onClick={() => setQuery("")}>×</button> : null}
                  </div>
                  {searchActive ? <p className="fm-side-caption" role="status">
                    {search.running ? t("searchScanning") : t("searchResultsCount", { count: search.hits.length })}
                  </p> : <p className="fm-side-hint">{t("searchHint")}</p>}
                  {searchActive ? (
                    <div className="fm-search-results" role="group" aria-label={t("search")}>
                      {search.running && !search.hits.length && <Skeleton kind="list" label={t('searchScanning')} />}
                      {!search.hits.length && !search.running ? <p className="fm-side-hint">{t("searchEmpty")}</p> : null}
                      {search.hits.map((hit) => (
                        <button
                          key={hit.path}
                          type="button"
                          title={hit.path}
                          className="fm-search-hit"
                          onClick={() => void openHit(hit)}
                        >
                          <FileIcon name={hit.name} isDirectory={hit.isDirectory} size={13} />
                          <span className="fm-search-hit-name">{hit.name}</span>
                          <span className="fm-search-hit-dir" dir="rtl">{parentOf(hit.path)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="fm-side-body">
                  {/* 树里这一条筛选只过滤已经加载的目录；整个项目的查找在「搜索」视图。 */}
                  <div className="fm-search">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
                    </svg>
                    <input
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }}
                      placeholder={t("filterPlaceholder")}
                      aria-label={t("filterFiles")}
                    />
                    {filter ? <button type="button" aria-label={t("clear")} onClick={() => setFilter("")}>×</button> : null}
                  </div>
                  <div className="fm-side-caption" title={gitSummaryText(gitSummary, t) ?? undefined}>
                    <span>{gitSummaryText(gitSummary, t) ?? t("treeSection")}</span>
                    <span className="fm-side-caption-actions">
                      <IconButton small label={t("expandAll")} disabled={expanding} onClick={() => void expandAll()}>
                        <path d="m8 8 4-4 4 4M8 16l4 4 4-4" />
                      </IconButton>
                    </span>
                  </div>
                  <Tree
                    key={activeRoot?.path}
                    onMove={remoteReadOnly || saving ? undefined : moveEntry}
                    onComposerFileDrag={!remoteReadOnly && root && activeRoot && window.pluginBridge?.startComposerFileDrag
                      ? (entry) => window.pluginBridge?.startComposerFileDrag?.({
                        workspace: root.path,
                        path: absoluteFullPath(entry.path, activeRoot),
                      }) ?? false
                      : undefined}
                    directories={directories}
                    expanded={expanded}
                    selected={selected}
                    showIgnored={prefs.showIgnored}
                    t={t}
                    filter={filter}
                    onToggle={path => { setSelected(path); toggleDirectory(path); }}
                    onOpen={requestOpen}
                    onRefreshDir={(path) => void loadDirectory(path, true)}
                    onContextMenu={openMenu}
                  />
                  {prefs.showIgnored || !ignoreActive ? null : (
                    <p className="fm-side-hint">{t("ignoredHidden")}</p>
                  )}
                </div>
              )}
            </>
          ) : null}
        </aside>

        {sidebarOpen ? <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebarWidth")}
          aria-controls="fm-sidebar"
          className="fm-gutter" {...sidebar.splitter}
        /> : null}

        <section className="fm-content" aria-label={t("title")}>
          {documentTabs.length || review.tabs.length ? (
            <div ref={stripRef} role="tablist" aria-label={t("openDocuments")} className="fm-document-tabs">
              {documentTabs.map(({ file, dirty: modified }) => {
                const name = baseNameOf(file.path);
                const label = (nameCounts.get(name) ?? 0) > 1 ? `${name} — ${parentOf(file.path) || "."}` : name;
                const active = file.path === openFile?.path && !activeReview;
                return <div className="fm-file-tab" key={file.path} data-active={active}>
                  <PaneTab id={fileTabId(file.path)} label={label} title={file.path} accessible={label + (modified ? " •" : "")} dirty={modified}
                    icon={<FileIcon name={name} isDirectory={false} size={13} />} active={active} onClick={() => void openEntry({ path: file.path })} />
                  <button type="button" className="fm-tab-close" title={`${t("close")} ${file.path}`} aria-label={`${t("close")} ${file.path}`}
                    disabled={saving} onClick={() => closeTab(file.path)}>×</button>
                </div>;
              })}
              {review.tabs.map(tab => {
                const key = reviewKey(tab);
                const active = key === review.active;
                const path = tab.kind === "diff" ? tab.path : tab.commit.oid;
                const label = tab.kind === "diff" ? baseNameOf(path) : path.slice(0, 7);
                const detail = tab.kind === "commit" ? t("gitCommit") : active && diffEntry && git.changesReady
                  ? t(diffScope === "staged" ? "diffScopeStaged" : "diffScopeWorktree") : t("changes");
                const description = tab.kind === "diff" ? `${path} · ${t("changes")}` : `${path.slice(0, 7)} · ${t("commitDetail")}`;
                return <div className="fm-file-tab" key={key} data-active={active}>
                  <PaneTab id={reviewTabId(key)} label={label} title={tab.kind === "diff" ? path : `${path} · ${tab.commit.subject}`}
                    accessible={description} detail={detail} icon={<GitIcon name={tab.kind === "diff" ? "changes" : "commit"} size={13} />}
                    active={active} onClick={() => activateReview(key)} />
                  <button type="button" className="fm-tab-close" title={`${t("close")} ${description}`} aria-label={`${t("close")} ${description}`}
                    onClick={() => closeReview(key)}>×</button>
                </div>;
              })}
            </div>
          ) : <div className="fm-document-tabs"><span className="fm-tabs-empty">{t("openDocuments")}</span></div>}

          {(openingPath || activeDiff || (openFile && !activeReview)) && <ContentBar>
            {openingPath ? <span className="fm-bar-title">{baseNameOf(openingPath)}</span> : activeDiff && !relatedDiff ? (
              <span className="fm-bar-title fm-bar-mono" title={activeDiff.path}>{activeDiff.path}</span>
            ) : openFile && <>
              {openFileGit && <span className="git-badge" style={{ color: gitColor(openFileGit.status) }} title={gitTitle(openFileGit, t)}>
                {gitGlyph(openFileGit.status)}
              </span>}
              <button type="button" className="fm-editor-path" title={`${t("copyPath")} · ${displayFilePath}`} aria-label={t("copyPath")}
                onClick={() => void copyPath(displayFilePath)}>{displayFilePath}</button>
              {options.length > 1 && <Segmented<ViewerMode | "diff"> label={t("viewMode")} panelId="fm-file-view" value={viewMode}
                options={options.map(({ key }) => ({ value: key, label: t(key === "diff" ? "changes" : MODE_LABEL[key]),
                  detail: key === "diff" && openFileGit && (openFileGit.added || openFileGit.deleted) ? `+${openFileGit.added} −${openFileGit.deleted}` : undefined }))}
                onChange={mode => {
                  if (mode === "diff") openDiff(openFile.path);
                  else { dispatchReview({ type: "document" }); changeViewerMode(mode); }
                }} />}
              {!activeReview && <div className="fm-file-tools">
                <span className="fm-editor-fact">{formatSize(openFile.size)}</span>
                {openFile.kind === "text" && <span className="fm-editor-fact">{t(openFile.readOnly ? "readOnly" : saving ? "saving" : dirty ? "dirty" : "saved")}</span>}
                <IconButton small label={t("reload")} onClick={reloadFromDisk} disabled={saving}><GitIconPath name="refresh" /></IconButton>
                {openFile.kind === "text" && <IconButton small label={t("save")} disabled={!dirty || saving || openFile.readOnly} onClick={() => void save()}>
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8" />
                </IconButton>}
              </div>}
            </>}
          </ContentBar>}

          <div className="fm-views" id="fm-content-panel" role={activeTabId ? "tabpanel" : undefined} aria-labelledby={activeTabId}>
            <div className="fm-views" id="fm-file-view" role={options.length > 1 ? "tabpanel" : undefined}
              aria-labelledby={options.length > 1 ? segmentId("fm-file-view", viewMode) : undefined}>
              {repoContext && activeCommit && <div className="fm-view">
                <GitCommitDetail oid={activeCommit.oid} locale={hostLocale} {...repoContext} />
              </div>}
              {repoContext && activeDiff && <div className="fm-view">
                <GitPreview key={reviewKey(activeDiff)} path={activeDiff.path} context={repoContext} panel={activeDiff.panel}
                  scope={diffScope} version={git.version} revision={activeDiff.panel ? git.snapshot?.revision : undefined}
                  pending={!!git.operation || (activeDiff.panel && !git.changesReady && !diffUnavailable)}
                  unchanged={activeDiff.panel && git.changesReady && !!git.snapshot && !diffEntry}
                  unavailable={diffUnavailable}
                  onBack={!activeDiff.panel || documents.get(activeDiff.path) || (diffEntry && diffEntry.worktree !== "D" && diffEntry.index !== "D")
                    ? () => void openEntry({ path: activeDiff.path }) : undefined}
                  onScope={(scope: GitScope) => dispatchReview({ type: "scope", key: reviewKey(activeDiff), scope })} onRefresh={git.refresh} t={t} />
              </div>}
              {openingPath && <div className="fm-view" aria-busy="true" aria-label={openingPath}>
                <Skeleton kind={/\.pdf$/i.test(openingPath) ? "page" : /\.(?:csv|tsv|xlsx|db|sqlite)$/i.test(openingPath) ? "table" : "lines"} label={`${t("loading")} ${baseNameOf(openingPath)}`} />
              </div>}
              <div className="fm-view" hidden={!documentVisible || !openFile}>
                <EditorPane file={openFile} visible={documentVisible} base={base} locale={hostLocale} dirty={dirty} saving={saving}
                  activeRoot={fileRoot} workspacePath={root?.path} viewer={viewer} tablePageSize={prefs.tablePageSize} t={t}
                  handleRef={handleRef} restore={documents.active?.editor} onPosition={caret.update} wrap={wrapLines}
                  onDirty={() => { if (openFile && !documents.get(openFile.path)?.dirty) documents.patch(openFile.path, { dirty: true }); }}
                  onSave={() => void save()} onReload={reloadFromDisk} onTablePageSize={size => persistPrefs({ tablePageSize: size })}
                  onLink={onLink} externalChange={externalChange} />
              </div>
            </div>
            {!openFile && !activeReview && !openingPath && root ? (
              <div className="fm-empty">
                <span className="fm-empty-glyph">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h6l2 2h10v12H3z" />
                  </svg>
                </span>
                <h3>{t("emptyWorkspaceTitle")}</h3>
                <p>{t("emptyWorkspaceCopy")}</p>
                <div className="fm-empty-actions">
                  <button type="button" className="fm-tbtn" onClick={() => showView("files")}>{t("viewFiles")}</button>
                  <button type="button" className="fm-tbtn" onClick={() => showView("git")}>{t("changes")}</button>
                </div>
                <div className="fm-empty-kbd">
                  <span>Ctrl+Shift+E</span><span>Ctrl+Shift+F</span><span>Ctrl+Shift+G</span><span>Ctrl+B</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <StatusBar
        t={t}
        branch={syncInfo?.state === "repository" ? syncInfo.branch || gitSummary?.branch || null : gitSummary?.branch ?? null}
        upstream={syncInfo?.upstream ?? null}
        ahead={syncInfo?.ahead ?? null}
        behind={syncInfo?.behind ?? null}
        watching={remoteReadOnly || !root ? null : prefs.watchFiles && watchAvailable}
        watchLabel={!prefs.watchFiles ? t("statusNotWatching") : t(watchAvailable ? "statusWatching" : "statusPolling")}
        cursor={sourceVisible ? caret : undefined} kind={kind}
      />

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />
      ) : null}

      {/* 组的文件夹菜单：只有一个 root（或老宿主不给组信息）时它根本不会被打开。 */}
      {rootMenu ? (
        <ContextMenu
          x={rootMenu.x}
          y={rootMenu.y}
          entries={rootMenuEntries()}
          onClose={closeRootMenu}
        />
      ) : null}

      {ready && !root ? (
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
                // Discard only as part of the requested close, reload or workspace reset.
                next?.();
              },
            },
            {
              label: t("saveAndSwitch"),
              variant: "primary",
              onPick: () => {
                const next = pendingRef.current;
                pendingRef.current = null;
                const paths = guard.paths;
                void (async () => {
                  for (const path of paths) if (documents.get(path)?.dirty && !await save(undefined, path)) { setGuard(null); return; }
                  setGuard(null); next?.();
                })();
              },
            },
          ]}
        />
      ) : null}

      {conflict ? (
        <ConfirmDialog
          title={t("conflictTitle")}
          body={t("conflictBody", { name: conflict.path })}
          actions={[
            { label: t("cancel"), onPick: () => setConflict(null) },
            {
              label: t("discardAndSwitch"),
              variant: "danger",
              onPick: () => {
                setConflict(null);
                void openEntry({ path: conflict.path }, false, true);
              },
            },
            {
              label: t("overwrite"),
              variant: "primary",
              onPick: () => {
                const current = conflict;
                setConflict(null);
                void save({ mtimeMs: current.mtimeMs, size: current.size }, current.path);
              },
            },
          ]}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteTitle")}
          body={t(confirmDelete.entry.isDirectory ? "deleteBodyDir" : "deleteBodyFile", {
            name: confirmDelete.entry.name,
          })}
          actions={[
            { label: t("cancel"), onPick: () => setConfirmDelete(null) },
            {
              label: t("delete"),
              variant: "danger",
              onPick: () => {
                // 先把状态摘出来再清空：onPick 里 confirmDelete 已经是闭包里的旧值。
                const current = confirmDelete.entry;
                setConfirmDelete(null);
                void runDelete(current);
              },
            },
          ]}
        />
      ) : null}

      {prompt ? (
        <PromptDialog
          title={t(prompt.kind === "rename" ? "renameTitle" : prompt.kind === "newFile" ? "newFileTitle" : "newFolderTitle")}
          hint={prompt.kind === "rename" ? t("renameFrom", { path: prompt.entry.path }) : t("createIn", { path: prompt.parent || "." })}
          label={t("nameLabel")}
          initialValue={prompt.kind === "rename" ? prompt.entry.name : ""}
          confirmLabel={t(prompt.kind === "rename" ? "confirm" : "create")}
          t={t}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => void onPromptSubmit(value)}
        />
      ) : null}
    </div>
  );
}

function PaneTab({ id, label, title, active, onClick, accessible, detail, dirty, icon }: {
  id: string; label: string; title?: string; active: boolean; onClick: () => void; accessible?: string;
  detail?: string; dirty?: boolean; icon?: React.ReactNode;
}) {
  return <button type="button" role="tab" id={id} aria-controls="fm-content-panel" aria-selected={active} aria-label={accessible ?? label} tabIndex={active ? 0 : -1}
    title={title ?? label} className="fm-tab" onClick={onClick} onKeyDown={event => nextTab(event)?.click()}>
    {icon}<span className="fm-tab-name">{label}</span>{dirty && <span className="fm-dirty-dot" aria-hidden="true" />}
    {detail && <span className="fm-tab-detail">{detail}</span>}
  </button>;
}


/** 菜单里的「当前就在看这个」：与树里的展开箭头同一套线条风格。 */
function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}
