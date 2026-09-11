/**
 * 高亮离线校验。
 *
 * 上次交付时我靠「包里有没有 python/rust 字样」判断高亮是否可用，这个判据
 * 是错的：真正的问题在运行时（basicSetup 自带的 fallback 高亮器盖住了自己的
 * 样式），grep 字符串看不出来。这个脚本改成真正跑一遍高亮链路：
 *
 *   文件名 → resolveLanguage → 加载语言 → EditorState → syntaxTree
 *          → highlightTree → 统计带 class 的 token 数
 *
 * 全流程不需要 DOM（EditorState/syntaxTree/highlightTree 都是纯计算），
 * 所以能在 Node 里跑，也就能进 CI。
 *
 * 用法：pnpm verify:highlight
 */

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 走 esbuild 把 TS 源码打成一个可以直接 import 的 ESM 文件。 */
async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-verify-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  // 入口放在临时目录里，相对路径解析不到源码，所以这里写绝对路径。
  const src = join(process.cwd(), "src", "lib");
  writeFileSync(
    entry,
    `export { tokenizeCode } from ${JSON.stringify(join(src, "highlight.ts"))};\n` +
      `export { resolveLanguage, isMarkdown } from ${JSON.stringify(join(src, "languages.ts"))};\n`,
  );

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

const SAMPLES = [
  {
    file: "src/app.ts",
    code: `import { useState } from "react";\n\n// a comment\nexport function App({ name }: { name: string }) {\n  const [n, setN] = useState<number>(0);\n  return n > 1 ? \`hi \${name}\` : null;\n}\n`,
  },
  {
    file: "src/main.py",
    code: `import os\n\n# a comment\ndef greet(name: str) -> str:\n    total = 42\n    return f"hello {name}" if total else "no"\n`,
  },
  {
    file: "src/lib.rs",
    code: `use std::collections::HashMap;\n\n// a comment\npub fn count(words: &[String]) -> HashMap<String, usize> {\n    let mut out = HashMap::new();\n    for w in words { *out.entry(w.clone()).or_insert(0) += 1; }\n    out\n}\n`,
  },
  {
    file: "src/server.go",
    code: `package main\n\nimport "fmt"\n\n// a comment\nfunc main() {\n\tname := "world"\n\tfmt.Printf("hello %s\\n", name)\n}\n`,
  },
  {
    file: "src/Button.tsx",
    code: `import React from "react";\n\nexport const Button = ({ label }: { label: string }) => (\n  <button className="btn" onClick={() => console.log(label)}>{label}</button>\n);\n`,
  },
  {
    file: "package.json",
    code: `{\n  "name": "demo",\n  "version": "1.0.0",\n  "private": true,\n  "count": 3\n}\n`,
  },
  {
    file: "styles/app.css",
    code: `.btn {\n  color: #fff;\n  padding: 4px 8px;\n}\n@media (min-width: 40rem) { .btn { padding: 8px; } }\n`,
  },
  {
    file: "index.html",
    code: `<!doctype html>\n<html lang="en">\n  <body><div class="app" data-x="1">hi</div></body>\n</html>\n`,
  },
  {
    file: "README.md",
    code: `# Title\n\nSome **bold** and \`code\`.\n\n- item\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`,
  },
  {
    file: "deploy.yaml",
    code: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo\nspec:\n  replicas: 3\n`,
  },
  {
    file: "Cargo.toml",
    code: `[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n`,
  },
  {
    file: "schema.sql",
    code: `-- a comment\nSELECT id, name FROM users WHERE id = 1 ORDER BY name ASC;\n`,
  },
  {
    file: "scripts/deploy.sh",
    code: `#!/usr/bin/env bash\nset -euo pipefail\n# a comment\nfor f in *.txt; do echo "$f"; done\n`,
  },
  {
    file: "src/Program.cs",
    code: `using System;\n\n// a comment\nclass Program { static void Main() { Console.WriteLine("hi"); } }\n`,
  },
  {
    file: "src/Main.kt",
    code: `package demo\n\n// a comment\nfun main() {\n    val greeting: String = "hi"\n    println(greeting)\n}\n`,
  },
  { file: "Dockerfile", code: `FROM node:22-alpine\nWORKDIR /app\nRUN npm ci\nCMD ["node", "index.js"]\n` },
  { file: "src/App.vue", code: `<template>\n  <div class="app">{{ title }}</div>\n</template>\n\n<script setup>\nconst title = "hi";\n</script>\n` },
];

const main = async () => {
  const mod = await loadModule();

  let failures = 0;
  console.log("file                     language        tokens  sample classes");
  console.log("-".repeat(84));

  for (const sample of SAMPLES) {
    const description = mod.resolveLanguage(sample.file);
    const tokens = await mod.tokenizeCode(sample.code, { fileName: sample.file }, "dark");

    const distinct = [...new Set(tokens.flatMap((token) => token.classes.split(/\s+/)))].filter(Boolean);
    const covered = tokens.reduce((sum, token) => sum + (token.to - token.from), 0);
    const ok = Boolean(description) && tokens.length > 0 && distinct.length >= 2;
    if (!ok) failures += 1;

    console.log(
      `${ok ? "ok  " : "FAIL"} ${sample.file.padEnd(20)} ${String(description?.name ?? "(none)").padEnd(15)} ${String(tokens.length).padStart(6)}  ${distinct.slice(0, 3).join(",") || "-"}   covered=${covered}`,
    );
  }

  // 反向断言：不该被认领的文件必须没有语言（否则会误高亮）。
  console.log("");
  for (const file of ["notes.txt", "data.bin", "archive.zip", "photo.png", "LICENSE"]) {
    const description = mod.resolveLanguage(file);
    const ok = description === null;
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${file.padEnd(20)} ${ok ? "correctly has no language" : `unexpectedly ${description.name}`}`);
  }

  // `.ts` 必须解析成 TypeScript 而不是被 JavaScript 抢走（这是之前用
  // language-data 自动匹配时会踩的坑）。
  console.log("");
  const ts = mod.resolveLanguage("a.ts");
  const tsx = mod.resolveLanguage("a.tsx");
  const tsOk = ts?.name === "TypeScript";
  const tsxOk = tsx?.name === "TSX";
  if (!tsOk) failures += 1;
  if (!tsxOk) failures += 1;
  console.log(`${tsOk ? "ok  " : "FAIL"} a.ts  → ${ts?.name} (expect TypeScript)`);
  console.log(`${tsxOk ? "ok  " : "FAIL"} a.tsx → ${tsx?.name} (expect TSX)`);

  console.log("");
  const mdOk = mod.isMarkdown("README.md") && mod.isMarkdown("docs/a.markdown") && !mod.isMarkdown("a.txt");
  if (!mdOk) failures += 1;
  console.log(`${mdOk ? "ok  " : "FAIL"} isMarkdown() gate for the preview toggle`);

  console.log(`\n${failures === 0 ? "HIGHLIGHT VERIFY PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("VERIFY HARNESS ERROR:", error);
  process.exit(1);
});
