/**
 * 语言注册表。
 *
 * 不用 @codemirror/language-data：它在运行期才 import 各自的语言包，而本插件
 * 的视图必须打成单个 IIFE（file:// 下无法加载额外 chunk），动态 import 的
 * 分包行为不可控，而且它的自动匹配会选错（.ts 会先匹配到别的东西）。
 *
 * 这里改成「静态 import + loader 返回已加载好的支持」，构建期即确定：
 *  · 所有语言都内联进同一个 bundle，离线可用；
 *  · 用显式的扩展名映射而不是启发式匹配，结果可预测。
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { less } from "@codemirror/lang-less";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

import { csharp, dart, kotlin, objectiveC, scala } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";

/** 把 legacy 的 StreamParser 包成一个 LanguageSupport。 */
const stream = (parser: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport =>
  new LanguageSupport(StreamLanguage.define(parser));

/** 扩展示例：`ts`、`d.ts` 这类多段后缀由 extensions 覆盖。 */
type Spec = {
  name: string;
  extensions: string[];
  filenames?: string[];
  load: () => LanguageSupport;
};

const SPECS: Spec[] = [
  {
    name: "TypeScript",
    extensions: ["ts", "mts", "cts"],
    load: () => javascript({ typescript: true }),
  },
  {
    name: "TSX",
    extensions: ["tsx"],
    load: () => javascript({ typescript: true, jsx: true }),
  },
  { name: "JavaScript", extensions: ["js", "mjs", "cjs"], load: () => javascript() },
  { name: "JSX", extensions: ["jsx"], load: () => javascript({ jsx: true }) },
  { name: "JSON", extensions: ["json", "jsonc", "json5", "map", "webmanifest"], load: () => json() },
  { name: "Markdown", extensions: ["md", "markdown", "mdx"], load: () => markdown() },
  { name: "CSS", extensions: ["css"], load: () => css() },
  { name: "SCSS", extensions: ["scss"], load: () => sass({ indented: false }) },
  { name: "Sass", extensions: ["sass"], load: () => sass({ indented: true }) },
  { name: "Less", extensions: ["less"], load: () => less() },
  { name: "HTML", extensions: ["html", "htm"], load: () => html() },
  { name: "Vue", extensions: ["vue"], load: () => vue() },
  { name: "XML", extensions: ["xml", "xsl", "xsd", "plist", "csproj", "svg"], load: () => xml() },
  { name: "YAML", extensions: ["yml", "yaml"], load: () => yaml() },
  { name: "TOML", extensions: ["toml"], load: () => stream(toml) },
  { name: "Properties", extensions: ["properties", "ini", "conf", "cfg", "editorconfig"], load: () => stream(properties) },
  { name: "Python", extensions: ["py", "pyi", "pyw"], load: () => python() },
  { name: "Go", extensions: ["go"], load: () => go() },
  { name: "Rust", extensions: ["rs"], load: () => rust() },
  { name: "Java", extensions: ["java"], load: () => java() },
  { name: "C++", extensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino"], load: () => cpp() },
  { name: "PHP", extensions: ["php", "phtml"], load: () => php() },
  { name: "C#", extensions: ["cs", "csx"], load: () => stream(csharp) },
  { name: "Kotlin", extensions: ["kt", "kts"], load: () => stream(kotlin) },
  { name: "Scala", extensions: ["scala", "sc"], load: () => stream(scala) },
  { name: "Dart", extensions: ["dart"], load: () => stream(dart) },
  { name: "Objective-C", extensions: ["m", "mm"], load: () => stream(objectiveC) },
  { name: "Ruby", extensions: ["rb", "rake", "gemspec"], filenames: ["Gemfile", "Rakefile"], load: () => stream(ruby) },
  { name: "Lua", extensions: ["lua"], load: () => stream(lua) },
  { name: "Shell", extensions: ["sh", "bash", "zsh", "ksh", "fish"], load: () => stream(shell) },
  { name: "PowerShell", extensions: ["ps1", "psm1", "psd1"], load: () => stream(powerShell) },
  { name: "SQL", extensions: ["sql"], load: () => sql() },
  { name: "Dockerfile", extensions: [], filenames: ["Dockerfile", "Containerfile"], load: () => stream(dockerFile) },
  { name: "Diff", extensions: ["diff", "patch"], load: () => stream(diff) },
];

/**
 * 每个扩展名只允许一个语言认领。LanguageDescription 在 extensions 重叠时
 * 会按声明顺序挑第一个，`.ts` 被 JS 抢走就是这么来的——所以这里自己建索引，
 * 一个扩展名一个语言，先声明者胜。
 */
const BY_EXTENSION = new Map<string, LanguageDescription>();
const BY_FILENAME = new Map<string, LanguageDescription>();
const BY_NAME = new Map<string, LanguageDescription>();

const DESCRIPTIONS: LanguageDescription[] = SPECS.map((spec) => {
  // LanguageDescription 只有 `filename`（正则），没有「特殊文件名列表」；
  // 而下面本来就自己建了文件名索引，所以这里不声明它。
  const description = LanguageDescription.of({
    name: spec.name,
    extensions: spec.extensions,
    load: async () => spec.load(),
  });
  for (const extension of spec.extensions) {
    if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, description);
  }
  for (const filename of spec.filenames ?? []) {
    const key = filename.toLowerCase();
    if (!BY_FILENAME.has(key)) BY_FILENAME.set(key, description);
  }
  if (!BY_NAME.has(spec.name)) BY_NAME.set(spec.name, description);
  return description;
});

/** 预览里 ```lang 的 lang 值可能写成别名。 */
const NAME_ALIASES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  node: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  python: "Python",
  golang: "Go",
  go: "Go",
  rs: "Rust",
  rust: "Rust",
  sh: "Shell",
  bash: "Shell",
  shell: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  yml: "YAML",
  yaml: "YAML",
  html: "HTML",
  xml: "XML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  vue: "Vue",
  java: "Java",
  ruby: "Ruby",
  lua: "Lua",
  php: "PHP",
  toml: "TOML",
  ini: "Properties",
  properties: "Properties",
  c: "C++",
  h: "C++",
  cpp: "C++",
  "c++": "C++",
  sql: "SQL",
  csharp: "C#",
  cs: "C#",
  "c#": "C#",
  kt: "Kotlin",
  kotlin: "Kotlin",
  scala: "Scala",
  dart: "Dart",
  objc: "Objective-C",
  "objective-c": "Objective-C",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  diff: "Diff",
  patch: "Diff",
};

export const languages = DESCRIPTIONS;

/** 按文件名（可带目录）解析语言；扩展名优先，其次特殊文件名。 */
export function resolveLanguage(filePath: string): LanguageDescription | null {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();

  const byName = BY_FILENAME.get(lower);
  if (byName) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot > 0 && dot < lower.length - 1) {
    const extension = lower.slice(dot + 1);
    const hit = BY_EXTENSION.get(extension);
    if (hit) return hit;
    // .d.ts 之类的多段后缀：取最后两段再试一次。
    const secondDot = lower.lastIndexOf(".", dot - 1);
    if (secondDot > 0) {
      const twoPart = `${lower.slice(secondDot + 1, dot)}.${extension}`;
      const twoHit = BY_EXTENSION.get(twoPart);
      if (twoHit) return twoHit;
    }
  }
  return null;
}

export function isMarkdown(filePath: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(filePath);
}

/** 供 Markdown 预览里的 ```lang 代码块使用。 */
export function resolveLanguageByName(name: string): LanguageDescription | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return BY_NAME.get(NAME_ALIASES[key] ?? "") ?? BY_NAME.get(key) ?? null;
}
