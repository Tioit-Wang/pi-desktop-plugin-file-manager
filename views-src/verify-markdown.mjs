/**
 * Markdown 渲染与链接白名单校验。
 *
 * 预览是「把文件内容变成界面」的路径，解析器写错了不会报错、只会静默显示错，
 * 所以这里断言真实产出的元素树。
 *
 * 用法：pnpm verify:markdown
 */

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-md-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  const src = join(process.cwd(), "src", "lib");

  writeFileSync(
    entry,
    `export { MarkdownPreview } from ${JSON.stringify(join(src, "markdown.tsx"))};\n` +
      `export { isSafeLink } from ${JSON.stringify(join(src, "linkSafety.ts"))};\n`,
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    // react 在 Node 里能直接解析；预览返回值是纯 React 元素对象，
    // 不需要 DOM 就能检查它的形状。
    external: [],
  });

  return import(pathToFileURL(out).href);
}

/** 把 React 元素树拍平成可断言的文本/标签序列。 */
function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node === "object" && node.type) {
    out.push({ tag: tagOf(node.type), props: node.props ?? {}, node });
    walk(node.props?.children, out);
    return out;
  }
  return out;
}

/** Fragment 的 type 是 Symbol，转成可读标签。 */
function tagOf(type) {
  if (typeof type === "string") return type;
  if (typeof type === "symbol") return String(type) === "Symbol(react.fragment)" ? "fragment" : "symbol";
  if (typeof type === "function") return type.name || "fn";
  return "unknown";
}

const tagNames = (tree) => walk(tree).filter((item) => typeof item === "object").map((item) => item.tag);
const text = (tree) => walk(tree).filter((item) => typeof item === "string").join("");

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `  → ${detail}` : ""}`);
};

const main = async () => {
  const mod = await loadModule();
  const noop = () => {};

  console.log("--- 链接白名单 ---");
  const safeLinks = ["https://example.com", "http://a.b/c", "mailto:a@b.c"];
  const unsafeLinks = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "/relative/path",
    "relative.md",
    "",
  ];
  for (const link of safeLinks) check(mod.isSafeLink(link), `safe: ${link}`);
  for (const link of unsafeLinks) check(!mod.isSafeLink(link), `refused: ${link}`);

  console.log("\n--- 块级元素 ---");
  // 期望值按真实产出写：最外层是 fragment，列表项内联内容包在 span 里，
  // 代码块由 CodeBlock 组件渲染（组件名可见，内部 pre 要渲染后才有）。
  const cases = [
    ["# 标题", ["fragment", "h1"]],
    ["## 二级", ["fragment", "h2"]],
    ["###### 六级", ["fragment", "h6"]],
    ["####### 七级不是标题", ["fragment", "p"]],
    ["普通段落", ["fragment", "p"]],
    ["---", ["fragment", "hr"]],
    ["> 引用", ["fragment", "blockquote", "p"]],
    ["- a\n- b", ["fragment", "ul", "li", "span", "li", "span"]],
    ["1. a\n2. b", ["fragment", "ol", "li", "span", "li", "span"]],
    ["```ts\nconst a = 1;\n```", ["fragment", "CodeBlock"]],
    [
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      ["fragment", "div", "table", "thead", "tr", "th", "th", "tbody", "tr", "td", "td"],
    ],
  ];

  for (const [source, expected] of cases) {
    const tags = tagNames(mod.MarkdownPreview({ text: source, base: "dark", onLink: noop }));
    const ok = JSON.stringify(tags) === JSON.stringify(expected);
    check(ok, `“${source.split("\n")[0]}” → ${expected.join(">")}`, `got ${tags.join(">")}`);
  }

  console.log("\n--- 行内元素 ---");
  const inline = [
    ["**粗**", "strong", "粗"],
    ["*斜*", "em", "斜"],
    ["~~删~~", "del", "删"],
    ["`code`", "code", "code"],
    ["a **b** c", "strong", "b"],
  ];
  for (const [source, tag, inner] of inline) {
    const tree = mod.MarkdownPreview({ text: source, base: "dark", onLink: noop });
    const tags = tagNames(tree);
    const body = text(tree);
    check(tags.includes(tag) && body.includes(inner), `${source} → <${tag}>${inner}</${tag}>`);
  }

  console.log("\n--- 行内嵌套（回归：共享 g 正则会吃光内存） ---");
  // renderInline 递归处理嵌套强调；如果复用同一个带 g 的正则实例，
  // 内层调用会破坏外层的 lastIndex，循环永不结束。这里给个短超时兜底。
  const nestedInline = [
    ["[**粗链接**](https://example.com)", "strong"],
    ["**粗 `代码` 粗**", "strong"],
    ["*斜 [链](https://a.b) 斜*", "em"],
    ["**a *b* c**", "strong"],
  ];
  for (const [source, tag] of nestedInline) {
    let tags = null;
    await Promise.race([
      Promise.resolve().then(() => {
        tags = tagNames(mod.MarkdownPreview({ text: source, base: "dark", onLink: noop }));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]).catch(() => {});
    check(Boolean(tags?.includes(tag)), `嵌套：${source}`, tags ? tags.join(">") : "超时/未返回");
  }

  console.log("\n--- 任务列表 ---");
  const taskTree = mod.MarkdownPreview({
    text: "- [x] 完成\n- [ ] 未完成",
    base: "dark",
    onLink: noop,
  });
  const boxes = walk(taskTree).filter((item) => typeof item === "object" && item.tag === "input");
  check(boxes.length === 2, "两个复选框", `got ${boxes.length}`);
  check(boxes[0]?.props.checked === true, "第一项已勾选");
  check(boxes[1]?.props.checked === false, "第二项未勾选");

  console.log("\n--- 嵌套列表 ---");
  const nested = mod.MarkdownPreview({
    text: "- a\n  - a1\n  - a2\n- b",
    base: "dark",
    onLink: noop,
  });
  const nestedTags = tagNames(nested);
  check(
    nestedTags.filter((tag) => tag === "ul").length === 2,
    "缩进产生第二层 ul",
    nestedTags.join(">"),
  );

  console.log("\n--- 链接渲染不导航 ---");
  let clicked = "";
  const linkTree = mod.MarkdownPreview({
    text: "[点我](https://example.com)",
    base: "dark",
    onLink: (url) => {
      clicked = url;
    },
  });
  const anchors = walk(linkTree).filter((item) => typeof item === "object" && item.tag === "a");
  check(anchors.length === 1, "渲染出一个链接");
  check(anchors[0]?.props.href === undefined, "不带 href（不会导航）");
  anchors[0]?.props.onClick?.({ preventDefault: noop });
  check(clicked === "https://example.com", "点击回调拿到 URL", clicked);

  console.log("\n--- 危险链接被标记，且仍不导航 ---");
  const evil = mod.MarkdownPreview({
    text: "[x](javascript:alert(1))",
    base: "dark",
    onLink: (url) => {
      clicked = `EVIL:${url}`;
    },
  });
  const evilAnchor = walk(evil).find((item) => typeof item === "object" && item.tag === "a");
  check(
    typeof evilAnchor?.props.className === "string" && evilAnchor.props.className.includes("unsafe"),
    "危险协议带 unsafe 类",
  );
  check(evilAnchor?.props.href === undefined, "危险链接同样没有 href");

  console.log("\n--- 无原始 HTML 注入面 ---");
  const xss = mod.MarkdownPreview({
    text: '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>',
    base: "dark",
    onLink: noop,
  });
  const xssTags = tagNames(xss);
  check(!xssTags.includes("img"), "原始 <img> 不会被解析成元素（被转义为文本）");
  check(!xssTags.includes("script"), "原始 <script> 不会被解析成元素");
  check(text(xss).includes("<script>"), "它们以纯文本形式原样显示");
  const usesDangerousHtml = walk(xss).some(
    (item) => typeof item === "object" && "dangerouslySetInnerHTML" in (item.props ?? {}),
  );
  check(!usesDangerousHtml, "任何节点都没有 dangerouslySetInnerHTML");

  console.log("\n--- 表格对齐 ---");
  const aligned = mod.MarkdownPreview({
    text: "| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |",
    base: "dark",
    onLink: noop,
  });
  const cells = walk(aligned).filter((item) => typeof item === "object" && item.tag === "td");
  check(cells[0]?.props.style?.textAlign === "left", "左对齐");
  check(cells[1]?.props.style?.textAlign === "center", "居中");
  check(cells[2]?.props.style?.textAlign === "right", "右对齐");

  console.log(`\n${failures === 0 ? "MARKDOWN VERIFY PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("VERIFY HARNESS ERROR:", error);
  process.exit(1);
});
