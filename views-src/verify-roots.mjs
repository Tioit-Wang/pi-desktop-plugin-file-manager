/**
 * 项目组（0.5.0）与「当前在看哪个文件夹」的离线校验。
 *
 * 视图与主进程各算一遍同一套规则：视图把它翻译成左上角切换器显示什么，主进程
 * 用它推导包含基点（哪个目录是「根」）。两边给出不同的答案，界面和越狱就会各说
 * 各话——比如树上是 beta 的目录，读取却按 alpha 解析。这里断言的是 lib/roots.ts
 * 的纯函数返回值，不需要 DOM（与 verify-markdown.mjs / verify-viewers.mjs 同样
 * 的做法），最后再回头核对 main.js 里那份同名常量，防止两边漂移。
 *
 * 用法：pnpm verify:roots
 */

import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function loadRoots() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-roots-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(entry, `export * as roots from ${JSON.stringify(join(here, "src", "lib", "roots.ts"))};\n`);

  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });

  return import(pathToFileURL(out).href);
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label} ${detail}`);
}

const roots = (await loadRoots()).roots;

const ALPHA = "C:\\Work\\Alpha";
const BETA = "C:\\Work\\Beta";
const group = {
  path: ALPHA,
  name: "alpha",
  projectId: "grp-1",
  roots: [
    { path: ALPHA, name: "alpha", primary: true },
    { path: BETA, name: "beta", primary: false },
  ],
};

console.log("1. 一个文件夹的项目（老宿主）");
const legacy = roots.normalizeRoots({ path: ALPHA, name: "alpha" });
check(
  "没有 roots 时退化成一个根，就是主根",
  legacy.length === 1 && legacy[0].path === ALPHA && legacy[0].name === "alpha" && legacy[0].primary === true,
  JSON.stringify(legacy),
);
check("路径末段补名字", roots.normalizeRoots({ path: "/work/alpha", name: "" })[0]?.name === "alpha");
check(
  "roots 全是垃圾时同样退化成一个根",
  roots.normalizeRoots({ path: ALPHA, name: "alpha", roots: [null, { path: "" }, 7] }).length === 1,
);
check("没有工作区（null）也没有根", roots.normalizeRoots({ path: "", name: "" }).length === 1);

console.log("\n2. 组的形状");
const shape = roots.normalizeRoots(group);
check("组顺序照抄宿主", shape.map((entry) => entry.path).join("|") === `${ALPHA}|${BETA}`);
check(
  "名字缺失时按路径末段补",
  roots.normalizeRoots({ path: ALPHA, name: "alpha", roots: [{ path: "C:\\Work\\Gamma", primary: false }] })[0]
    ?.name === "Gamma",
);
check("primaryRootOf 认标记", roots.primaryRootOf(shape)?.path === ALPHA);
check(
  "primaryRootOf 一个都没标时取第一个",
  roots.primaryRootOf([
    { path: BETA, name: "beta", primary: false },
    { path: ALPHA, name: "alpha", primary: false },
  ])?.path === BETA,
);
check("primaryRootOf 空表给 null", roots.primaryRootOf([]) === null);

console.log("\n3. 记忆键");
check("有 projectId 用 p: 前缀", roots.projectKeyOf(group) === "p:grp-1");
check("没有 projectId 退回主根路径", roots.projectKeyOf({ path: ALPHA, name: "alpha" }) === `r:${ALPHA}`);

console.log("\n4. 选中的是哪个文件夹");
check("记忆命中时用它", roots.resolveSelectedRoot(shape, BETA)?.path === BETA);
check(
  "记忆命中大小写不同的同一个目录",
  roots.resolveSelectedRoot(shape, BETA.toUpperCase())?.path === BETA,
  roots.resolveSelectedRoot(shape, BETA.toUpperCase())?.path,
);
check("没有记忆时用主根", roots.resolveSelectedRoot(shape, undefined)?.path === ALPHA);
check(
  "记忆指向已被移出组的目录时退回主根（绝不给一棵空树）",
  roots.resolveSelectedRoot(shape, "C:\\Work\\Gone")?.path === ALPHA,
);
check("空组给 null", roots.resolveSelectedRoot([], BETA) === null);

console.log("\n5. 绝对路径归到哪个 root");
const hit = roots.findRootForPath(shape, join(BETA, "src", "a.ts"));
check("兄弟文件夹里的文件归到那个 root", hit?.root.path === BETA && hit.rel === "src/a.ts", JSON.stringify(hit));
check("root 自身是空相对路径", roots.findRootForPath(shape, BETA)?.rel === "");
check("末尾多一个分隔符还是同一个目录", roots.findRootForPath(shape, `${BETA}\\`)?.rel === "");
check(
  "大小写与分隔符混用也认",
  roots.relativeInside(ALPHA, "c:/work/alpha/lib/x.ts") === "lib/x.ts",
  String(roots.relativeInside(ALPHA, "c:/work/alpha/lib/x.ts")),
);
check("组外的绝对路径给 null", roots.findRootForPath(shape, "C:\\Other\\a.ts") === null);
check(
  "名字有前缀关系的兄弟目录不算命中",
  roots.findRootForPath(shape, "C:\\Work\\Beta-old\\a.ts") === null,
  JSON.stringify(roots.findRootForPath(shape, "C:\\Work\\Beta-old\\a.ts")),
);
check("相对路径没有「落在哪个 root 里」这回事", roots.findRootForPath(shape, "src/a.ts") === null);
check("父目录不是子目录", roots.relativeInside(join(ALPHA, "lib"), ALPHA) === null);

console.log("\n6. 按项目记忆（LRU）");
const before = { a: "1", b: "2", c: "3" };
const after = roots.rememberProjectRoot(before, "a", "9");
check("重写的键挪到末尾", Object.keys(after).join(",") === "b,c,a", Object.keys(after).join(","));
check("重写不改输入", Object.keys(before).join(",") === "a,b,c");
check("非字符串值被丢掉", !("d" in roots.rememberProjectRoot({ d: 5 }, "x", "1")));
check("空记忆也能写进去", roots.rememberProjectRoot(undefined, "x", "1").x === "1");
let memory = {};
for (let index = 1; index <= roots.MAX_PROJECT_ROOTS + 5; index += 1) {
  memory = roots.rememberProjectRoot(memory, `k${index}`, "v");
}
check("记忆有界", Object.keys(memory).length === roots.MAX_PROJECT_ROOTS, `got ${Object.keys(memory).length}`);
check("丢的是最旧的那些", !("k1" in memory) && !("k5" in memory));
check(
  "最近写入的那条还在，且在末尾",
  memory[`k${roots.MAX_PROJECT_ROOTS + 5}`] === "v" && Object.keys(memory).at(-1) === `k${roots.MAX_PROJECT_ROOTS + 5}`,
);

console.log("\n7. 与主进程那份规则不漂移");
// 视图与 main.js 是两份独立实现（一个 TypeScript 给界面，一个 CommonJS 给越狱），
// 没有共享模块。上限、记忆键前缀这一类「两边必须是同一个数/同一串」的东西只能在
// 这里对文本核对，写歪了就是界面和越狱各按一个基点解析。
const mainSource = readFileSync(join(here, "..", "main.js"), "utf8");
check(
  "main.js 的记忆上限与视图一致",
  mainSource.includes(`const MAX_PROJECT_ROOTS = ${roots.MAX_PROJECT_ROOTS};`),
);
check("main.js 的项目键同样用 p: / r: 两个前缀", mainSource.includes("p:${workspace.projectId}") && mainSource.includes("r:${workspace.path}"));

console.log(`\n${failures === 0 ? "ROOTS VERIFY PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
