/**
 * 文件监听（0.8.0）：外部改动能不能被自动发现并交给视图的离线校验。
 *
 * 两层：
 *   ① 纯判定：哪些事件**不该**被上报（.git / node_modules / 凭据路径 / 本插件的
 *      原子写临时文件），以及「这是我自己写的吗」这条抑制规则。抑制错了的后果很
 *      具体：用户按一次 Ctrl+S，自己的文档就被重新装载一遍，光标与滚动位置一起丢。
 *   ② 端到端：临时目录 + 桩宿主驱动真实的 main.js，断言**操作系统真的把事件送到
 *      了**——外部改 / 外部建 / 外部删都出现在游标增量里；同一游标重复问是幂等的；
 *      本插件自己的写不进增量；非工作区目录报告不可用；onUnload 之后监听确实停了。
 *   ③ 视图的判定（纯函数 lib/watch.ts）：什么时候悄悄重读、什么时候只提示。
 *      这一层是监听里唯一有判断的地方，写反的后果是「用户的编辑被系统弄丢」。
 */

import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { internals } = require(pluginMain);

// ── 1. 噪声与抑制规则 ───────────────────────────────────────────────────────

console.log("1. 哪些事件不该上报");

check("普通文件要上报", internals.isWatchIgnored("src/a.ts") === false);
check("根目录本身要上报（平台不给文件名时的退路）", internals.isWatchIgnored("") === false);
check(".git/ 里的一切不报", internals.isWatchIgnored(".git/index") === true && internals.isWatchIgnored(".git/objects/ab/cdef") === true);
check("node_modules/ 不报", internals.isWatchIgnored("node_modules/x/y.js") === true && internals.isWatchIgnored("a/node_modules/x.js") === true);
check(
  "凭据类路径不报（监听不是绕过黑名单的后门）",
  internals.isWatchIgnored(".env") === true && internals.isWatchIgnored("config/.env.local") === true && internals.isWatchIgnored("keys/id_rsa") === true,
);
check("原子写的临时文件不报", internals.isWatchIgnored(".README.md.m1730abcd.ef12.tmp") === true);
check("同名的真实文件还是要报", internals.isWatchIgnored("notes.tmp") === false && internals.isWatchIgnored("a.tmp.md") === false);

// 抑制规则：记一笔之后的短时间内，同名事件不算「外部改动」。
// 这里用的是一条**与端到端不相干**的路径：抑制是有时限的，串到下一段会让后面的
// 「外部改动被发现」断言变得不确定。
check("没记过的路径不算自己写的", internals.isSelfWrite("unit/only-here.ts") === false);
internals.noteSelfWrite("unit/only-here.ts");
check("刚记过的路径算自己写的", internals.isSelfWrite("unit/only-here.ts") === true);
check("别的路径不受影响", internals.isSelfWrite("unit/other.ts") === false);
// 目录项事件：Windows 的递归监听在写文件时，会额外给「它所在的每一层目录」各报一次
// `change <目录>`（见 main.js noteSelfWrite 的注释）。这些目录事件必须同样算「自己写的」，
// 否则每按一次 Ctrl+S 还是会被其中一条判成外部改动。
internals.noteSelfWrite("deep/nested/x.ts");
check("写过的文件所在目录算自己写的", internals.isSelfWrite("deep/nested") === true);
check("更上层祖先目录也算（每一层都会报）", internals.isSelfWrite("deep") === true);
check("不相干的目录仍不算", internals.isSelfWrite("other") === false);
check("根路径不因写文件被记（根自身不发目录事件）", internals.isSelfWrite("") === false);

// ── 2. 端到端：真的 fs.watch + 真的 main.js ─────────────────────────────────

console.log("\n2. 端到端：操作系统的事件真的到得了视图");

const root = mkdtempSync(join(tmpdir(), "pifm-watch-"));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, "node_modules", "left-pad"), { recursive: true });
writeFileSync(join(project, "src", "a.ts"), "one\n");
writeFileSync(join(project, ".git", "index"), "index\n");
writeFileSync(join(project, "node_modules", "left-pad", "index.js"), "module\n");

const settings = { fmPrefs: {} };
const workspace = { path: project, name: "project" };
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

const { onLoad, onUnload, onPanelInvoke } = require(pluginMain);
await onLoad();

/** 轮询到没有新变化为止（模拟视图：拿游标来取增量），返回这段时间内出现的路径。 */
async function drain(before, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  let cursor = before;
  for (;;) {
    const response = await onPanelInvoke("fm.watch", { since: cursor });
    if (response.changed.length) {
      for (const path of response.changed) seen.add(path);
      cursor = response.revision;
    }
    if (seen.size > 0 || Date.now() > deadline) return { seen, cursor, response };
    await sleep(60);
  }
}

/**
 * 静默到「连着两轮都没有新变化」为止，返回稳定的游标。
 *
 * 需要的理由：操作系统的事件可能比「谁引起它」晚到（上一段的外部新建 / 删除就会），那些
 * 迟到的目录事件属于**上一段**，不该被算进下面这一次操作里——否则断言会随机红一次。
 */
async function settle(from, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = from;
  let quiet = 0;
  while (quiet < 2 && Date.now() < deadline) {
    await sleep(internals.WATCH_DEBOUNCE_MS * 2);
    const response = await onPanelInvoke("fm.watch", { since: cursor });
    if (response.changed.length === 0) {
      quiet += 1;
    } else {
      quiet = 0;
      cursor = response.revision;
    }
  }
  return cursor;
}

try {
  const hello = await onPanelInvoke("fm.hello", {});
  check("hello 说这个运行时能监听", hello.watch?.available === true, JSON.stringify(hello.watch));
  check("自动刷新默认是开的", hello.prefs?.watchFiles === true);

  // 第一次轮询顺带把监听打开。
  const first = await onPanelInvoke("fm.watch", { since: 0 });
  check("监听可用", first.available === true, JSON.stringify(first));
  check("一开始没有变化", first.changed.length === 0 && first.revision === 0, JSON.stringify(first));
  check("游标 stale 标记：没有历史时不报", first.stale === false);

  // 外部改动一个已存在的文件
  const cursor0 = first.revision;
  writeFileSync(join(project, "src", "a.ts"), "one\ntwo\n");
  const modified = await drain(cursor0);
  check("外部修改被发现了", modified.seen.has("src/a.ts"), [...modified.seen].join("|"));

  // 幂等：拿同一个游标再问一次，不该把同一件事再报一遍
  const repeat = await onPanelInvoke("fm.watch", { since: cursor0 });
  check("同一游标重复问是幂等的", repeat.changed.filter((path) => path === "src/a.ts").length === 1, JSON.stringify(repeat.changed));

  // 外部新建
  let cursor = modified.cursor;
  writeFileSync(join(project, "src", "new.ts"), "brand new\n");
  const created = await drain(cursor);
  check("外部新建被发现了", created.seen.has("src/new.ts"), [...created.seen].join("|"));

  // 外部删除
  cursor = created.cursor;
  unlinkSync(join(project, "src", "new.ts"));
  const removed = await drain(cursor);
  check("外部删除被发现了", removed.seen.has("src/new.ts"), [...removed.seen].join("|"));

  // 噪声：.git 与 node_modules
  cursor = removed.cursor;
  writeFileSync(join(project, ".git", "index"), "index changed\n");
  writeFileSync(join(project, "node_modules", "left-pad", "index.js"), "module changed\n");
  await sleep(internals.WATCH_DEBOUNCE_MS * 4);
  const noise = await onPanelInvoke("fm.watch", { since: cursor });
  check(
    ".git 与 node_modules 的变化不进增量",
    noise.changed.length === 0,
    JSON.stringify(noise.changed),
  );

  // 本插件自己的写：不能被当成外部改动（否则每按一次 Ctrl+S 就重装一次文档）
  // 迟到的目录事件属于上一段（外部新建 / 删除），先静稳再取游标：否则上一段那条
  // `change src` 会随机落进下面这一次保存的窗口里，让这条断言变成「偶尔红一次」。
  cursor = await settle(noise.revision);
  const read = await onPanelInvoke("fm.read", { path: "src/a.ts" });
  const saved = await onPanelInvoke("fm.write", {
    path: "src/a.ts",
    text: "one\ntwo\nthree\n",
    expectedMtimeMs: read.mtimeMs,
    expectedSize: read.size,
    eol: "lf",
    bom: false,
  });
  check("写入成功", saved.ok === true, JSON.stringify(saved));
  await sleep(internals.WATCH_DEBOUNCE_MS * 4);
  const afterSave = await onPanelInvoke("fm.watch", { since: cursor });
  check(
    "自己保存引起的 rename 事件不进增量",
    afterSave.changed.length === 0,
    JSON.stringify(afterSave.changed),
  );

  // 抑制是有时限的：过了窗口，同名变化照旧要报（否则监听会慢慢失灵）
  cursor = afterSave.revision;
  await sleep(internals.SELF_WRITE_SUPPRESS_MS + 200);
  writeFileSync(join(project, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
  const later = await drain(cursor);
  check("抑制窗口过后，同名改动照旧上报（监听不会慢慢失灵）", later.seen.has("src/a.ts"), [...later.seen].join("|"));

  // 嵌套目录里的文件：祖先目录的 `change <目录>` 事件也要被抑制掉，不能只按文件路径抑制。
  // 在这一段之前已经空转过 SELF_WRITE_SUPPRESS_MS，所以上一笔 fm.write 的抑制窗口早就过期了，
  // 这里报出来的任何东西都只可能来自这一次保存（上游目录事件同样会按「自己写的」处理）。
  cursor = later.cursor;
  mkdirSync(join(project, "src", "deep"), { recursive: true });
  writeFileSync(join(project, "src", "deep", "nested.ts"), "nested one\n");
  const quietCursor = await settle(cursor); // 外部创建的事件先流干净（含迟到的目录事件）
  const nestedRead = await onPanelInvoke("fm.read", { path: "src/deep/nested.ts" });
  const nestedSave = await onPanelInvoke("fm.write", {
    path: "src/deep/nested.ts",
    text: "nested one\nnested two\n",
    expectedMtimeMs: nestedRead.mtimeMs,
    expectedSize: nestedRead.size,
    eol: "lf",
    bom: false,
  });
  check("嵌套文件的写入成功", nestedSave.ok === true, JSON.stringify(nestedSave));
  await sleep(internals.WATCH_DEBOUNCE_MS * 4);
  const afterNestedSave = await onPanelInvoke("fm.watch", { since: quietCursor });
  check(
    "嵌套文件保存后，连祖先目录的目录项事件也不进增量",
    afterNestedSave.changed.length === 0,
    JSON.stringify(afterNestedSave.changed),
  );

  // 换基点：监听跟着换
  const other = join(root, "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "b.ts"), "b\n");
  cursor = later.cursor;
  workspace.path = other;
  const switched = await onPanelInvoke("fm.watch", { since: cursor });
  check("换文件夹后监听仍然可用", switched.available === true, JSON.stringify(switched));
  writeFileSync(join(other, "b.ts"), "b\ntwo\n");
  const afterSwitch = await drain(switched.revision);
  check("换文件夹后监听的是新文件夹", afterSwitch.seen.has("b.ts"), [...afterSwitch.seen].join("|"));

  // 没有工作区：报告不可用，而不是抛错
  workspace.path = "";
  const noWorkspace = await onPanelInvoke("fm.watch", { since: 0 });
  check("没有项目时报告不可用且不抛错", noWorkspace.ok === true && noWorkspace.available === false, JSON.stringify(noWorkspace));

  // 卸载：监听必须一起走
  workspace.path = project;
  const rearmed = await onPanelInvoke("fm.watch", { since: 0 });
  check("重新有项目后监听复活", rearmed.available === true);
  await onUnload();
  const cursorAfterUnload = rearmed.revision;
  await sleep(internals.WATCH_DEBOUNCE_MS);
  writeFileSync(join(project, "src", "a.ts"), "one\ntwo\nthree\nfour\nfive\n");
  await sleep(internals.WATCH_DEBOUNCE_MS * 4);
  const afterUnload = await onPanelInvoke("fm.watch", { since: cursorAfterUnload });
  check("onUnload 之后监听真的停了（没有新增量）", afterUnload.revision === cursorAfterUnload, JSON.stringify(afterUnload));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── 3. 视图的判定：重读还是提示 ───────────────────────────────────────────

console.log("\n3. 视图收到变化之后怎么反应（lib/watch.ts）");

async function loadView() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-watch-view-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(entry, `export * as watch from ${JSON.stringify(join(here, "src", "lib", "watch.ts"))};\n`);
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
  return loaded.watch;
}

const { decideWatchAction } = await loadView();
const decide = (changed, dirty, openPath = "src/a.ts", stale = false) =>
  decideWatchAction({ changed, stale, openPath, dirty });

check(
  "变化在别处：只刷目录，不动打开的文件",
  decide(["src/b.ts"], false).refreshDirs.join() === "src" &&
    decide(["src/b.ts"], false).reload === false &&
    decide(["src/b.ts"], false).warn === false,
  JSON.stringify(decide(["src/b.ts"], false)),
);
check(
  "打开的文件被改、且没有未保存改动 → 自动重新读取",
  decide(["src/a.ts"], false).reload === true && decide(["src/a.ts"], false).warn === false,
  JSON.stringify(decide(["src/a.ts"], false)),
);
check(
  "打开的文件被改、但有未保存改动 → 只提示，绝不覆盖",
  decide(["src/a.ts"], true).warn === true && decide(["src/a.ts"], true).reload === false,
  JSON.stringify(decide(["src/a.ts"], true)),
);
check("根目录下的文件归到根目录去刷", decide(["a.ts"], false).refreshDirs.join() === "");
check("多个变化只刷一次同一个目录", decide(["src/a.ts", "src/b.ts"], false).refreshDirs.join() === "src");
check(
  "批量改动时刷新目录数有上限（不把面板打满）",
  decide(Array.from({ length: 30 }, (_, index) => `d${index}/f.ts`), false).refreshDirs.length === 8,
);
check("没打开任何文件时只刷目录", decide(["src/a.ts"], false, null).reload === false);
check(
  "游标落到历史之外：保守地把根目录也刷一遍",
  decide([], false, "src/a.ts", true).refreshDirs.includes("") &&
    decide([], false, "src/a.ts", true).reload === true,
  JSON.stringify(decide([], false, "src/a.ts", true)),
);
check(
  "游标之外 + 有未保存改动：仍然只提示不覆盖",
  decide([], true, "src/a.ts", true).warn === true && decide([], true, "src/a.ts", true).reload === false,
);

console.log(`\n${failures === 0 ? "WATCH VERIFY PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
