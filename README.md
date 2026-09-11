# 文件管理器（File Manager）

在 PI-Desktop 的**右侧工作面板**里浏览并编辑当前项目的文件：完整目录树（图标随文件类型变化）、左右分栏、内容可编辑保存，以及新建、重命名/移动、按文件名搜索。

## 功能

- **完整目录树**：懒加载、可按层展开、目录在前。每一行的图标随文件类型变化——文件夹、代码、JSON、Markdown、样式、HTML/Vue/Svelte、YAML/TOML、Shell、SQL、图片、压缩包、字体、锁文件等各有自己的字形与配色；`package.json`、`Dockerfile`、`LICENSE`、`.gitignore` 这类特殊文件名优先于扩展名判定。
- **选中态与悬停态明确区分**：悬停是淡淡的中性底色（只表示鼠标位置）；选中是强调色底 + 左侧强调色竖条 + 前景色文字 + 中等字重，鼠标移开也保持，悬停到选中行上还会再加深一档，不会让人误以为选中丢了。
- **右键菜单**：在文件/文件夹上右键可新建文件、新建文件夹、重命名、移动、打开、刷新；在列表空白处右键则只提供「在此新建」与刷新。支持 ↑↓ / Home / End / Enter / Esc。
- **左右分栏**：左侧文件列表，右侧内容。中间分隔条可拖拽，宽度会记住。
- **代码高亮编辑**：CodeMirror 6，行号、查找替换、多光标、括号匹配、代码折叠。按文件名加载对应语言的语法高亮，覆盖 TypeScript/TSX、JavaScript/JSX、JSON、Markdown、CSS/SCSS/Sass/Less、HTML、Vue、XML、YAML、TOML、Properties、Python、Go、Rust、Java、C/C++、C#、Kotlin、Scala、Dart、Objective-C、PHP、Ruby、Lua、Shell、PowerShell、SQL、Dockerfile、Diff。全部随包内置、离线可用，不请求网络。`Ctrl/Cmd+S` 或工具栏按钮保存。
- **Markdown 预览 / 编辑切换**：打开 `.md` / `.markdown` / `.mdx` 时，工具栏出现「编辑 / 预览」切换。预览支持标题、围栏代码块（带同样的语法高亮）、引用、分隔线、有序/无序/任务列表（按缩进嵌套）、表格（含对齐）、行内 code / 粗体 / 斜体 / 删除线 / 链接 / 图片。切换会记住。
- **文件操作**：新建文件、新建文件夹、重命名、移动到指定目录。
- **按文件名搜索**：整个项目范围内分页搜索，点击结果直接跳转并展开到该文件。
- **忽略规则**：项目里有 `.gitignore` / `.ignore` 就按规则隐藏条目（可用工具栏的眼睛按钮切回显示）；**一个规则文件都没有时，目录树展示全部条目**。
- **跟随宿主外观**：亮/暗配色与界面语言（中文 / English）跟随 PI-Desktop 主体，编辑器与预览的高亮配色一并跟随。

## 安装

在 PI-Desktop 的 Plugins 页面：

1. **Load development plugin** → 选择本目录；或
2. 用 `dist/pi.file-manager-0.1.0.piplug` 走 **Install plugin package**。

装好后打开一个项目，在**右侧工作面板头部的切换菜单 → “Plugin views / 插件视图”** 分组里点击「文件管理器」。

> 这个插件没有命令面板入口，也不注册面板窗口——它只提供一个停靠在右侧栏的视图（`contributes.views`）。宿主没有提供「用命令打开视图」的通道，所以这里也不声明误导性的命令。

## 开发

```bash
cd views-src
pnpm install
pnpm typecheck
pnpm build      # 产物输出到 ../views（入库，宿主加载 views/index.html）
```

`views-src` 是源码（React + TypeScript + Tailwind + CodeMirror 6）；`views` 是构建产物，直接入库。构建为 **IIFE 单文件**并内联全部动态 import——宿主的视图用 `file://` 加载页面，`type="module"` 与 `crossorigin` 会被 Chromium 拦掉，所以 `vite.config.ts` 里有一个 `fileProtocolCompat` 插件负责改写 `index.html`。

`main.js` 是手写、零依赖的 CommonJS，插件的依赖不会被安装，所以不要往它里面 `require` 第三方包。

### 校验

```bash
cd views-src
pnpm typecheck
pnpm verify        # 语法高亮 + Markdown 预览的离线校验
```

`pnpm verify` 跑两个不需要 DOM 的校验脚本，用于覆盖「静默失败」的两条链路：

- **`verify-highlight.mjs`**：对 17 种真实文件走完整的
  `文件名 → 语言解析 → 载入 → 语法树 → 高亮 token` 链路，断言每种都产出足够多的
  不同高亮 class，并反向断言 `.txt` / `.bin` / `.zip` / `.png` / `LICENSE` 不会被误认领。
  CodeMirror 的高亮是「解析不出来就什么都不报」的典型——只 grep 产物字符串会漏掉
  运行时问题（本插件第一版就踩过：`basicSetup` 自带的 fallback 高亮器把自己的样式盖住了）。
- **`verify-markdown.mjs`**：断言预览真实产出的元素树（标题/列表/表格/任务列表/嵌套
  强调），链接协议白名单，以及**不存在 `dangerouslySetInnerHTML`**、原始 HTML 被转义。
  其中一个回归用例专门盯住「行内解析递归时共享带 `g` 的正则」——那会让预览卡死并吃光内存。

冒烟测试（在仓库根目录运行）：

```bash
node ../pi-file-manager-smoke-test.cjs
```

## 数据与安全

**这个插件用自己的 Node `fs` 读写当前项目里的文件，而不是宿主的 `pi.fs` 网关。**

为什么必须这样：宿主的 `manifest.fs` 在语法上就**禁止整树写入**（写入 scope 不能是 `**`），任何一个能通过校验的窄 scope 都会让「保存」变成每次都弹权限确认；而且 `pi.fs.*` 没有创建/重命名/移动，`fs.glob` 与 `fs.list` 还有条数上限、会跳过 `node_modules`、屏蔽凭据路径。与之对应的代价是：**宿主的权限网关不介入这些调用**，所以安全责任由插件自己承担。manifest 里因此只申报了 `ui.view`，没有申报 `fs.read` / `fs.write`——申报了反而是误导（写权限根本无法诚实申报）。

插件自己实施的全部限制：

| 限制 | 说明 |
|---|---|
| 路径包含 | 只接受相对项目根的路径；绝对路径、`..`、以及 realpath 后落到根目录之外的**符号链接 / junction** 一律拒绝 |
| 敏感路径 | `.env*`、`.ssh`、`.aws`、`.gnupg`、`.git/**`、`*.pem`、`*.key`、`*.p12` 等读写全拒；`node_modules` 可读不可写 |
| 原子写 | 先写同目录临时文件 → `fsync` → 保留原文件权限位 → `rename` 覆盖，中断不会留下半写文件 |
| 冲突检测 | 以 `mtimeMs` + 文件大小作为乐观锁；文件在编辑器之外被改动过时**不会静默覆盖**，会先弹对话框让你选择覆盖 / 放弃 / 重新加载 |
| 写入审计 | 每次写入追加一行到插件数据目录的 `write-audit.jsonl`（约 1 MiB 后轮转），因为宿主审计不到这条路径 |
| 体积上限 | 预览 2 MiB、写入 8 MiB；二进制文件与图片不进入编辑器，只提示 |

行为上的两点说明：

- `.git` 目录**不会出现在树里**（体量巨大且永远无用）。
- 忽略规则来自 `.gitignore` 与 `.ignore`（支持 `!` 取反、末尾 `/`、前导 `/` 锚定、`*` / `?` / `**`）。这是 gitignore 的一个子集，不支持 `\` 转义和 `[a-z]` 字符类；偏差只影响「显不显示」，且随时可以用工具栏的眼睛按钮翻盘。

**Markdown 预览的安全做法**：预览**不使用** `dangerouslySetInnerHTML`，而是把 Markdown 解析成 React 元素——节点由 React 转义，结构上不存在注入面，因此也不需要额外的 sanitizer。原因很直接：这个视图的 bridge 通向一个能读写项目文件的插件主进程，预览里的 XSS 就等于任意文件写入。预览中的链接也不会导航（点一下就离开插件页面回不来了），点击只会把地址显示出来。

**不访问网络**：没有 `net.domains`，运行时不发起任何请求。插件数据目录里只放设置（分栏宽度、显示开关、Markdown 默认视图）和上面那份审计日志。

## 已知限制

- **不删除文件/目录**。删除是破坏性操作，而且宿主的 `fs.remove` 并没有开放给视图桥，只能走原生 `rm`——本期不做。
- **没有「在文件夹中显示」/「用系统程序打开」**：这两个宿主通道需要 `fs.read` 权限，而本插件有意不申报任何 fs 权限。
- **预览里的图片不加载**：面板以 `file://` 加载，相对路径指向视图自身而不是项目，所以图片显示为带文件名的占位块，而不是破图。
- **文件监听**：宿主没有「插件 → 视图」的推送通道（视图只能发起请求、拿响应），所以外部改动不是实时的；保存后会刷新、工具栏也有手动刷新按钮。
- 二进制与图片不可编辑，也不做图片预览（与宿主内置的「文件」视图一致）。

## 许可

MIT。
