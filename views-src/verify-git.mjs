/**
 * git 联动（0.7.0）：状态识别与变更内容的离线校验。
 *
 * 三层：
 *   ① 纯函数：`git status --porcelain=v1 -z` / `git diff --numstat -z` /
 *      unified diff 的**输出形态**在 git 版本之间变过好几次（重命名在 -z 下是两条
 *      记录、numstat 的重命名把路径留空再补两条裸路径、hunk 头可有可无的行号
 *      段）。这里用固定夹具把这些形态钉死——解析错了，界面上就是「已修改」显示成
 *      「已新增」这种静默的错。
 *   ② 展示层：状态 → 徽标字母 / 颜色 / tooltip / 概览文案，以及中英文案表必须一一
 *      对齐（少一个中文键，界面上就会突然冒出一句英文，而 tsc 抓不到）。
 *   ③ 端到端：起一个真的临时仓库，用桩宿主驱动真实的 main.js（onLoad +
 *      onPanelInvoke），断言 fm.list 的徽标、fm.read 带回来的状态、fm.git.diff
 *      给出的具体改动行，以及「非仓库 / 凭据黑名单 / 保存后状态要立刻跟上」。
 *      没装 git 的机器上第三层整体跳过（前两层仍然跑）。
 *
 * 用法：pnpm verify:git
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginMain = join(here, "..", "main.js");
const require = createRequire(pluginMain);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label} ${detail}`);
}

const { internals } = require(pluginMain);

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
check("六条记录（重命名只算一条）", porcelain.length === 6, `got ${porcelain.length}`);
  }
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

// ── 1. porcelain v1 的解析 ───────────────────────────────────────────────────

console.log("1. `git status --porcelain=v1 -z` 的形态");

const porcelain = internals.parsePorcelainV1(
  Buffer.from(
    [
      " M src/a.ts",
      "?? src/new.ts",
      "M  staged.ts",
      " D gone.ts",
      "R  src/to.ts",
      "src/from.ts",
      "UU conflict.ts",
      "",
    ].join("\0"),
    "utf8",
  ),
);
check("六条记录（重命名只算一条，另一条是它的原路径）", porcelain.length === 6, `got ${porcelain.length}`);
check("未暂存的修改", porcelain[0].x === " " && porcelain[0].y === "M" && porcelain[0].path === "src/a.ts");
check("未跟踪", porcelain[1].x === "?" && porcelain[1].y === "?" && porcelain[1].path === "src/new.ts");
check("已暂存的修改", porcelain[2].x === "M" && porcelain[2].y === " ");
check("已删除（工作区里没了）", porcelain[3].y === "D");
check(
  "重命名是两条记录，裸路径不误认成记录",
  porcelain[4].x === "R" && porcelain[4].path === "src/to.ts" && porcelain[4].origPath === "src/from.ts",
  JSON.stringify(porcelain[4]),
);
check("冲突", porcelain[5].x === "U" && porcelain[5].y === "U" && porcelain[5].path === "conflict.ts");

console.log("\n2. 两列状态 → 显示用的状态");
const classify = (x, y) => internals.classifyRecord({ x, y, path: "p" });
check("?? → 新增且未跟踪", classify("?", "?").status === "added" && classify("?", "?").untracked === true);
check("A  → 新增且已暂存", classify("A", " ").status === "added" && classify("A", " ").staged === true);
check(" M → 已修改", classify(" ", "M").status === "modified" && classify(" ", "M").staged === false);
check("M  → 已修改且已暂存", classify("M", " ").status === "modified" && classify("M", " ").staged === true);
check(" M 与 M  都算已修改", classify("M", "M").status === "modified");
check("D  → 已删除", classify("D", " ").status === "deleted");
check(" D → 已删除（未暂存）", classify(" ", "D").status === "deleted" && classify(" ", "D").staged === false);
check("R  → 已重命名", classify("R", " ").status === "renamed");
check("UU / AA / DD → 冲突", classify("U", "U").status === "conflicted" && classify("A", "A").status === "conflicted" && classify("D", "D").status === "conflicted");
check("未知的两列不硬猜", classify(" ", " ") === null);

// ── 3. numstat ──────────────────────────────────────────────────────────────

console.log("\n3. `git diff --numstat -z` 的形态");
const numstat = internals.parseNumstat(
  Buffer.from(["3\t1\tsrc/a.ts", "0\t2\tsrc/b.ts", "-\t-\timg/logo.png", "1\t1\t", "src/from.ts", "src/to.ts", ""].join("\0"), "utf8"),
);
check("增删行数按路径归位", numstat.get("src/a.ts")?.added === 3 && numstat.get("src/a.ts")?.deleted === 1);
check("另一条", numstat.get("src/b.ts")?.added === 0 && numstat.get("src/b.ts")?.deleted === 2);
check("二进制是 - - 而不是 NaN", numstat.get("img/logo.png")?.binary === true && numstat.get("img/logo.png")?.added === 0);
check(
  "重命名的统计挂在新路径上",
  numstat.get("src/to.ts")?.added === 1 && numstat.get("src/to.ts")?.deleted === 1 && !numstat.has("src/from.ts"),
  [...numstat.keys()].join(","),
);

// ── 4. unified diff ─────────────────────────────────────────────────────────

console.log("\n4. unified diff → 渲染用的行");
const diff = internals.parseUnifiedDiff(
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,4 @@ function head() {",
    " keep",
    "-old",
    "+new",
    "+extra",
    " tail",
    "",
  ].join("\n"),
);
check("文件头进 meta", diff.meta.includes("diff --git a/src/a.ts b/src/a.ts") && diff.meta.includes("+++ b/src/a.ts"));
check("一个 hunk", diff.hunks.length === 1);
check("hunk 头解析出两侧起始行", diff.hunks[0].oldStart === 1 && diff.hunks[0].newStart === 1);
check("hunk 头后面的函数名", diff.hunks[0].section === "function head() {");
check(
  "行类型与行号",
  diff.hunks[0].lines.map((line) => line.type).join(",") === "ctx,del,add,add,ctx" &&
    diff.hunks[0].lines[1].oldLine === 2 &&
    diff.hunks[0].lines[2].newLine === 2 &&
    diff.hunks[0].lines[4].oldLine === 3,
  JSON.stringify(diff.hunks[0].lines),
);
check("行文本去掉前缀", diff.hunks[0].lines[1].text === "old" && diff.hunks[0].lines[0].text === "keep");

const binaryDiff = internals.parseUnifiedDiff("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n");
check("二进制单独标记，不当 hunk", binaryDiff.binary === true && binaryDiff.hunks.length === 0);

const twoHunks = internals.parseUnifiedDiff(
  ["@@ -1,2 +1,2 @@", "-a", "+b", "@@ -10,2 +10,3 @@", " c", "+d", "+e"].join("\n"),
);
check("多个 hunk", twoHunks.hunks.length === 2);
check(
  "第二个 hunk 的行号从自己的头接着数",
  twoHunks.hunks[1].oldStart === 10 && twoHunks.hunks[1].lines[1].newLine === 11,
  JSON.stringify(twoHunks.hunks[1]),
);

const fresh = internals.untrackedDiff("alpha\nbeta\n", false);
check(
  "未跟踪文件：每一行都是新增，行号从 1 开始",
  fresh.hunks[0].lines.length === 2 &&
    fresh.hunks[0].lines.every((line) => line.type === "add") &&
    fresh.hunks[0].lines[1].newLine === 2,
);
check("未跟踪文件头是 /dev/null", fresh.meta[0] === "--- /dev/null");

// ── 5. 目录汇总 ─────────────────────────────────────────────────────────────

console.log("\n5. 子树变化汇总到直接子目录");
const snapshot = {
  files: new Map([
    ["src/a.ts", { status: "modified", staged: false, untracked: false, added: 2, deleted: 1, binary: false }],
    ["src/deep/b.ts", { status: "added", staged: false, untracked: true, added: 0, deleted: 0, binary: false }],
    ["docs/readme.md", { status: "modified", staged: false, untracked: false, added: 1, deleted: 0, binary: false }],
    ["top.txt", { status: "deleted", staged: true, untracked: false, added: 0, deleted: 5, binary: false }],
  ]),
};
const groups = internals.rollupByChildDirectory(snapshot, "");
check("子目录拿到汇总", groups.get("src")?.changed === 2, JSON.stringify(groups.get("src")));
check(
  "取子树里最值得注意的状态（新增 > 修改）",
  groups.get("src")?.status === "added",
  groups.get("src")?.status,
);
check("行数相加", groups.get("src")?.added === 2 && groups.get("src")?.deleted === 1);
check("子目录里的文件不会被算到兄弟目录上", groups.has("docs") && !groups.has("top.txt"));
const nested = internals.rollupByChildDirectory(snapshot, "src");
check("列子目录时按新的前缀重新归组", nested.size === 1 && nested.has("deep") && nested.get("deep").status === "added");

// ── 6. 展示层：状态 → 徽标 / 文案 ────────────────────────────────────────────

console.log("6. 展示层（lib/git.ts 与 i18n.ts）");

/** 把 lib/git.ts 与 i18n.ts 打成一份可执行的 ESM（与 verify-roots.mjs 同样做法）。 */
async function loadView() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-git-view-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(
    entry,
    `export * as git from ${JSON.stringify(join(here, "src", "lib", "git.ts"))};\n` +
      `export { COPY_TABLES } from ${JSON.stringify(join(here, "src", "i18n.ts"))};\n`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(out).href);
  rmSync(dir, { recursive: true, force: true });
  return loaded;
}

const view = await loadView();
const { gitGlyph, gitColor, gitTitle, gitSummaryText, lookupGit } = view.git;
const { COPY_TABLES } = view;

// 徽标字母与 git 自己的心智模型一致：这一层错了，用户会先怀疑插件而不是自己。
check(
  "徽标字母 A/M/D/R/U",
  ["added", "modified", "deleted", "renamed", "conflicted"].map(gitGlyph).join("") === "AMDRU",
  ["added", "modified", "deleted", "renamed", "conflicted"].map(gitGlyph).join(""),
);
const colors = ["added", "modified", "deleted", "renamed", "conflicted", "typechange"].map((status) =>
  gitColor(status),
);
check("五类变化各有各的颜色（互不相同）", new Set(colors).size === 5, colors.join(" "));
check("类型变更复用「已修改」的颜色（它对用户就是修改）", colors[5] === colors[1]);

// tooltip：状态名 + 暂存/未跟踪 + 行数，三样各占一段
const t = (key, values = {}) => (COPY_TABLES.zh[key] ?? "").replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
const modifiedTitle = gitTitle({ status: "modified", staged: false, untracked: false, added: 3, deleted: 1 }, t);
check("已修改：说清状态与 +N/−N", modifiedTitle.includes("已修改") && modifiedTitle.includes("+3") && modifiedTitle.includes("−1"), modifiedTitle);
check(
  "未跟踪的新增文件不会被说成已暂存",
  gitTitle({ status: "added", staged: false, untracked: true, added: 0, deleted: 0 }, t).includes("未纳入版本控制"),
  gitTitle({ status: "added", staged: false, untracked: true, added: 0, deleted: 0 }, t),
);
check(
  "目录徽标给的是受影响文件数而不是行数",
  gitTitle({ status: "added", staged: false, untracked: true, added: 2, deleted: 0, changed: 4 }, t).includes("4"),
);

// 概览：分支 + 各类计数；干净时另一句
const summary = gitSummaryText({ available: true, branch: "main", total: 3, counts: { modified: 1, added: 1, deleted: 1, renamed: 0, conflicted: 0 } }, t);
check("概览带上分支与各类计数", summary.includes("main") && summary.includes("1 个已修改") && summary.includes("1 个新增") && summary.includes("1 个已删除"), String(summary));
check(
  "没有变化时是另一句话（不是一串 0）",
  gitSummaryText({ available: true, branch: "main", total: 0, counts: { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 } }, t).includes("工作区干净"),
);
check("没有 git 时概览是 null（头部回退到「文件」）", gitSummaryText({ available: false }, t) === null && gitSummaryText(null, t) === null);

// lookupGit：先看自己那行，没有就往上找祖先目录的汇总
const treeDirs = new Map([
  ["", { entries: [{ path: "src", name: "src", isDirectory: true, mtimeMs: 0, ignored: false, isSymlink: false, outside: false, git: { status: "added", staged: false, untracked: true, added: 0, deleted: 0, changed: 2 } }] }],
  ["src", { entries: [{ path: "src/a.ts", name: "a.ts", isDirectory: false, mtimeMs: 0, ignored: false, isSymlink: false, outside: false, git: { status: "modified", staged: false, untracked: false, added: 1, deleted: 1 } }, { path: "src/b.ts", name: "b.ts", isDirectory: false, mtimeMs: 0, ignored: false, isSymlink: false, outside: false, git: null }] }],
]);
check("自己那行有状态就用自己的", lookupGit(treeDirs, "src/a.ts")?.status === "modified");
check("自己那行是 null 时不算有状态", lookupGit(treeDirs, "src/b.ts") === null);
check("目录没展开时往上找祖先的汇总", lookupGit(treeDirs, "src/deep/c.ts")?.status === "added");
check("整棵树都没加载时是 null", lookupGit(new Map(), "src/a.ts") === null);

// 中英文案必须一一对齐：少一个中文键，界面上会突然冒一句英文，而 tsc 抓不到。
const enKeys = Object.keys(COPY_TABLES.en);
const zhKeys = Object.keys(COPY_TABLES.zh);
const missingZh = enKeys.filter((key) => !zhKeys.includes(key));
const missingEn = zhKeys.filter((key) => !enKeys.includes(key));
check("中英文案键完全对齐", missingZh.length === 0 && missingEn.length === 0, `zh 缺 ${missingZh.join(",")}；en 缺 ${missingEn.join(",")}`);
check("git 相关的键两种语言都有", ["changes", "viewChanges", "gitModified", "gitAdded", "gitScopeStaged", "gitDiffBinary"].every((key) => zhKeys.includes(key) && enKeys.includes(key)));

// ── 7. 端到端：真的仓库 + 真的 main.js ───────────────────────────────────────

if (!hasGit()) {
  console.log("\n7. 端到端：跳过（本机没有 git）");
} else {
  const root = mkdtempSync(join(tmpdir(), "pifm-git-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "docs", "readme.md"), "# doc\n");
    writeFileSync(join(repo, "clean.txt"), "clean\n");
    git(repo, ["init", "-q", "-b", "main", "."]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    // 从头到尾都不动的两个文件：quiet.txt 留在原地，gone.txt 提交后被删掉。
    writeFileSync(join(repo, "quiet.txt"), "quiet\n");
    writeFileSync(join(repo, "gone.txt"), "gone\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);

    // 一处修改、一处新增、一处删除、一处已暂存。
    writeFileSync(join(repo, "src", "a.ts"), "one\nTWO\nthree\n");
    writeFileSync(join(repo, "src", "new.ts"), "brand new\nsecond line\n");
    rmSync(join(repo, "docs", "readme.md"));
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "clean.txt"), "clean\ntouched\n");
    git(repo, ["add", "clean.txt"]);
    const settings = { fmPrefs: {} };
    const workspace = { path: repo, name: "repo" };
    globalThis.pi = {
      workspace: { get: async () => workspace },
      plugin: {
        getDataPath: async () => join(root, "data"),
        getSettings: async () => settings,
        setSettings: async (value) => {
          settings = value;
          return true;
        },
      },
      ui: { showToast: () => {} },
      fs: {},
    };

    const { onLoad, onPanelInvoke } = require(pluginMain);
    await onLoad();

    console.log("7. 端到端：真的仓库 + 真的 main.js");
    const listing = await onPanelInvoke("fm.list", { path: "" });
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
    check("git 可用", listing.git?.available === true, JSON.stringify(listing.git));
    check("带上了分支名", listing.git?.branch === "main", String(listing.git?.branch));
    check("改动总数（改 2、增 1、删 2）", listing.git?.total === 5, String(listing.git?.total));
    check("按状态分桶", listing.git?.counts?.modified === 2 && listing.git?.counts?.added === 1 && listing.git?.counts?.deleted === 2, JSON.stringify(listing.git?.counts));
    check(
      "已暂存的修改标出 staged",
      byName.get("clean.txt")?.git?.status === "modified" && byName.get("clean.txt")?.git?.staged === true,
      JSON.stringify(byName.get("clean.txt")?.git),
    );
    check(
      "目录上给的是子树汇总（2 个文件，新增 > 修改）",
      byName.get("src")?.git?.changed === 2 && byName.get("src")?.git?.status === "added",
      JSON.stringify(byName.get("src")?.git),
    );
    check("没改动的文件不带徽标", byName.get("quiet.txt")?.git === null, JSON.stringify(byName.get("quiet.txt")));
    check("被删除的文件已经不在列表里", !byName.has("gone.txt"));
    check(
      "目录里唯一的变化是删除时，目录徽标也是删除",
      byName.get("docs")?.git?.status === "deleted" && byName.get("docs")?.git?.changed === 1,
      JSON.stringify(byName.get("docs")?.git),
    );

    const subListing = await onPanelInvoke("fm.list", { path: "src" });
    const subByName = new Map(subListing.entries.map((entry) => [entry.name, entry]));
    check(
      "已修改的文件被认出来",
      subByName.get("a.ts")?.git?.status === "modified" && subByName.get("a.ts")?.git?.staged === false,
      JSON.stringify(subByName.get("a.ts")?.git),
    );
    check(
      "增删行数跟着徽标一起给",
      subByName.get("a.ts")?.git?.added === 1 && subByName.get("a.ts")?.git?.deleted === 1,
      JSON.stringify(subByName.get("a.ts")?.git),
    );
    check(
      "新增的文件与已修改的区分得开（未跟踪）",
      subByName.get("new.ts")?.git?.status === "added" &&
        subByName.get("new.ts")?.git?.untracked === true &&
        subByName.get("new.ts")?.git?.staged === false,
      JSON.stringify(subByName.get("new.ts")?.git),
    );

    console.log("\n8. 变更内容（fm.git.diff）");
    const diffModified = await onPanelInvoke("fm.git.diff", { path: "src/a.ts" });
    check("返回成功", diffModified.ok === true, JSON.stringify(diffModified).slice(0, 200));
    check("一段差异（工作区）", diffModified.sections?.length === 1 && diffModified.sections[0].scope === "worktree");
    const lines = diffModified.sections[0].hunks[0].lines;
    check(
      "具体改了什么：一行被替换",
      lines.some((line) => line.type === "del" && line.text === "two") &&
        lines.some((line) => line.type === "add" && line.text === "TWO"),
      JSON.stringify(lines),
    );
    check("行数统计", diffModified.addedLines === 1 && diffModified.deletedLines === 1);

    const diffUntracked = await onPanelInvoke("fm.git.diff", { path: "src/new.ts" });
    check(
      "新增文件：全文都是新增行",
      diffUntracked.untracked === true &&
        diffUntracked.sections[0].hunks[0].lines.every((line) => line.type === "add") &&
        diffUntracked.addedLines === 2,
      JSON.stringify(diffUntracked.sections?.[0]?.hunks?.[0]?.lines),
    );

    const diffStaged = await onPanelInvoke("fm.git.diff", { path: "clean.txt" });
    check(
      "已暂存的内容按「已暂存」这一段给出",
      diffStaged.sections?.length === 1 && diffStaged.sections[0].scope === "staged",
      JSON.stringify(diffStaged.sections?.map((section) => section.scope)),
    );
    check("暂存段里能看到新加的那一行", diffStaged.sections[0].hunks[0].lines.some((line) => line.text === "touched"));

    const diffQuiet = await onPanelInvoke("fm.git.diff", { path: "quiet.txt" });
    check("没改动的文件是 none（不是错误）", diffQuiet.ok === true && diffQuiet.kind === "none", JSON.stringify(diffQuiet).slice(0, 160));

    // 预算就是 MAX_DIFF_LINES（20000），所以这份文件要比它还多出几行。
    const bigLines = Array.from({ length: internals.MAX_DIFF_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
    writeFileSync(join(repo, "big.txt"), `${bigLines}\n`);
    git(repo, ["add", "big.txt"]);
    writeFileSync(join(repo, "big.txt"), `${bigLines}\nextra\n`);
    const bigDiff = await onPanelInvoke("fm.git.diff", { path: "big.txt" });
    const bigShown = bigDiff.sections.reduce(
      (sum, section) => sum + section.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
      0,
    );
    check(
      "行数超预算时真的截断，并给出标志",
      bigDiff.truncated === true && bigShown <= internals.MAX_DIFF_LINES,
      `shown=${bigShown} limit=${internals.MAX_DIFF_LINES}`,
    );
    check(
      "截断不影响前部的正确性（该给的行都给了）",
      bigDiff.sections[0].hunks[0].lines.some((line) => line.type === "add" && line.text === "extra"),
    );

    const diffDeleted = await onPanelInvoke("fm.git.diff", { path: "gone.txt" });
    check(
      "已删除的文件仍能看差异（全是删除行）",
      diffDeleted.ok === true &&
        diffDeleted.status?.status === "deleted" &&
        diffDeleted.sections[0].hunks[0].lines.some((line) => line.type === "del" && line.text === "gone"),
      JSON.stringify(diffDeleted).slice(0, 220),
    );

    const escapeInside = await onPanelInvoke("fm.git.diff", { path: "src/../clean.txt" });
    check("带 .. 的路径照旧被拒绝", escapeInside.ok === false && escapeInside.code === "ESCAPE", JSON.stringify(escapeInside));

    const deniedDiff = await onPanelInvoke("fm.git.diff", { path: ".env" });
    check("凭据文件仍然进不来", deniedDiff.ok === false && deniedDiff.code === "DENIED_PATH");
    const escapeDiff = await onPanelInvoke("fm.git.diff", { path: "../outside.txt" });
    check("越界路径被拒绝", escapeDiff.ok === false && escapeDiff.code === "ESCAPE", JSON.stringify(escapeDiff));

    console.log("\n9. 打开文件时也带状态；保存后状态立刻跟上");
    const readBack = await onPanelInvoke("fm.read", { path: "src/a.ts" });
    check("fm.read 带上了这个文件的 git 状态", readBack.git?.status === "modified", JSON.stringify(readBack.git));
    const readQuiet = await onPanelInvoke("fm.read", { path: "quiet.txt" });
    check("没变化的文件是 null", readQuiet.git === null, JSON.stringify(readQuiet.git));

    await onPanelInvoke("fm.write", {
      path: "src/a.ts",
      text: "one\nTWO\nthree\nfour\n",
      expectedMtimeMs: readBack.mtimeMs,
      expectedSize: readBack.size,
      eol: "lf",
      bom: false,
    });
    const afterSave = await onPanelInvoke("fm.list", { path: "src" });
    const savedEntry = afterSave.entries.find((entry) => entry.name === "a.ts");
    check("保存后立刻反映新的行数（缓存已作废）", savedEntry?.git?.added === 2 && savedEntry?.git?.deleted === 1, JSON.stringify(savedEntry?.git));
    const diffAfterSave = await onPanelInvoke("fm.git.diff", { path: "src/a.ts" });
    check("保存后的差异里能看到新加的那一行", diffAfterSave.sections[0].hunks[0].lines.some((line) => line.text === "four"));

    console.log("\n10. 不是仓库的文件夹：降级成「没有状态」，其余照旧");
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.txt"), "a\n");
    workspace.path = plain;
    workspace.name = "plain";
    const plainListing = await onPanelInvoke("fm.list", { path: "" });
    check("列表照常返回", plainListing.ok === true && plainListing.entries.length === 1);
    check("git 不可用时只是没有状态", plainListing.git?.available === false && plainListing.entries[0].git === null);
    const plainDiff = await onPanelInvoke("fm.git.diff", { path: "a.txt" });
    check("差异请求明确说不可用", plainDiff.ok === false && plainDiff.code === "GIT_UNAVAILABLE", JSON.stringify(plainDiff));
    const plainRead = await onPanelInvoke("fm.read", { path: "a.txt" });
    check("读文件照旧", plainRead.ok === true && plainRead.text === "a\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? "GIT VERIFY PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
