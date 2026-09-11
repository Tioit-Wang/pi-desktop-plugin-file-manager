/**
 * 文件类型图标。
 *
 * 宿主只决定视图启动器那一行的图标（固定 token 表），树内的图标完全由插件
 * 自绘——所以这里手写一组内联 SVG，不引第三方图标库，保持 main.js 之外的
 * 运行时代价可控（全部随包，离线可用）。
 *
 * 解析顺序：特殊文件名 → 扩展名 → 目录 / 兜底。
 */

import type { ReactNode } from "react";

const GLYPH: Record<string, ReactNode> = {
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  folderOpen: (
    <>
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
    </>
  ),
  code: (
    <>
      <path d="m9 18-6-6 6-6" />
      <path d="m15 6 6 6-6 6" />
    </>
  ),
  braces: (
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1" />
    </>
  ),
  hash: (
    <>
      <path d="M4 9h16M4 15h16" />
      <path d="M10 3 8 21M16 3l-2 18" />
    </>
  ),
  markdown: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M8 16v-4l2 2 2-2v4" />
    </>
  ),
  style: <path d="M12 3s6 6.3 6 10a6 6 0 0 1-12 0c0-3.7 6-10 6-10z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  font: (
    <>
      <path d="M5 20 12 4l7 16" />
      <path d="M8.5 14h7" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h9M19 8h1M4 16h3M12 16h8" />
      <circle cx="15.5" cy="8" r="2" />
      <circle cx="9.5" cy="16" r="2" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="6" r="2.5" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M6.5 8.5v7" />
      <path d="M17.5 11.5c0 3.2-4 3.4-7 4.3" />
    </>
  ),
  package: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </>
  ),
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  book: (
    <>
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
    </>
  ),
};

type Spec = { glyph: keyof typeof GLYPH; color: string };

const C = {
  default: "var(--muted)",
  folder: "var(--icon-folder)",
  code: "#3178c6",
  script: "#d9a300",
  data: "#c07a1f",
  markup: "#e0724a",
  style: "#4aa3d9",
  doc: "var(--icon-doc)",
  shell: "#4e9a06",
  image: "#26a269",
  archive: "#a8823c",
  font: "#8e7cc3",
  lock: "#c0703c",
  db: "#d64b4b",
  git: "#e0724a",
  pkg: "#cb8a2e",
  secret: "#9a5bd6",
} as const;

/** 特殊文件名优先于扩展名，因为它们的意义与扩展名不同。 */
const BY_NAME: Record<string, Spec> = {
  ".gitignore": { glyph: "branch", color: C.git },
  ".gitattributes": { glyph: "branch", color: C.git },
  ".gitmodules": { glyph: "branch", color: C.git },
  ".npmrc": { glyph: "sliders", color: C.secret },
  ".env": { glyph: "lock", color: C.secret },
  ".editorconfig": { glyph: "sliders", color: C.default },
  ".prettierrc": { glyph: "sliders", color: C.default },
  ".eslintrc": { glyph: "sliders", color: C.default },
  dockerfile: { glyph: "package", color: C.style },
  "docker-compose.yml": { glyph: "package", color: C.style },
  "docker-compose.yaml": { glyph: "package", color: C.style },
  makefile: { glyph: "terminal", color: C.shell },
  license: { glyph: "shield", color: C.doc },
  "license.md": { glyph: "shield", color: C.doc },
  "license.txt": { glyph: "shield", color: C.doc },
  "package.json": { glyph: "package", color: C.pkg },
  "package-lock.json": { glyph: "lock", color: C.default },
  "pnpm-lock.yaml": { glyph: "lock", color: C.default },
  "yarn.lock": { glyph: "lock", color: C.default },
  "cargo.lock": { glyph: "lock", color: C.default },
  "cargo.toml": { glyph: "package", color: C.data },
  "go.mod": { glyph: "package", color: C.style },
  "go.sum": { glyph: "lock", color: C.default },
  "tsconfig.json": { glyph: "sliders", color: C.code },
  "jsconfig.json": { glyph: "sliders", color: C.script },
  "vite.config.ts": { glyph: "sliders", color: C.data },
  "vite.config.js": { glyph: "sliders", color: C.data },
  "readme.md": { glyph: "book", color: C.doc },
  "changelog.md": { glyph: "book", color: C.doc },
};

const BY_EXT: Record<string, Spec> = {
  ts: { glyph: "code", color: C.code },
  tsx: { glyph: "code", color: C.code },
  mts: { glyph: "code", color: C.code },
  cts: { glyph: "code", color: C.code },
  js: { glyph: "code", color: C.script },
  jsx: { glyph: "code", color: C.script },
  mjs: { glyph: "code", color: C.script },
  cjs: { glyph: "code", color: C.script },
  json: { glyph: "braces", color: C.data },
  jsonc: { glyph: "braces", color: C.data },
  json5: { glyph: "braces", color: C.data },
  map: { glyph: "braces", color: C.default },
  md: { glyph: "markdown", color: C.doc },
  markdown: { glyph: "markdown", color: C.doc },
  mdx: { glyph: "markdown", color: C.doc },
  txt: { glyph: "file", color: C.doc },
  css: { glyph: "style", color: C.style },
  scss: { glyph: "style", color: "#cf649a" },
  sass: { glyph: "style", color: "#cf649a" },
  less: { glyph: "style", color: "#4aa3d9" },
  html: { glyph: "globe", color: C.markup },
  htm: { glyph: "globe", color: C.markup },
  vue: { glyph: "globe", color: "#41b883" },
  svelte: { glyph: "globe", color: "#ff3e00" },
  astro: { glyph: "globe", color: "#ff5d01" },
  xml: { glyph: "globe", color: C.data },
  svg: { glyph: "image", color: C.image },
  yml: { glyph: "sliders", color: C.data },
  yaml: { glyph: "sliders", color: C.data },
  toml: { glyph: "sliders", color: C.data },
  ini: { glyph: "sliders", color: C.data },
  conf: { glyph: "sliders", color: C.data },
  env: { glyph: "lock", color: C.secret },
  properties: { glyph: "sliders", color: C.data },
  py: { glyph: "code", color: "#3776ab" },
  pyi: { glyph: "code", color: "#3776ab" },
  rb: { glyph: "code", color: "#cc342d" },
  php: { glyph: "code", color: "#8892bf" },
  go: { glyph: "code", color: "#00add8" },
  rs: { glyph: "code", color: "#d08770" },
  java: { glyph: "code", color: "#e76f00" },
  kt: { glyph: "code", color: "#a97bff" },
  kts: { glyph: "code", color: "#a97bff" },
  scala: { glyph: "code", color: "#dc322f" },
  swift: { glyph: "code", color: "#f05138" },
  c: { glyph: "code", color: "#5c6bc0" },
  h: { glyph: "code", color: "#5c6bc0" },
  cc: { glyph: "code", color: "#5c6bc0" },
  cpp: { glyph: "code", color: "#5c6bc0" },
  cxx: { glyph: "code", color: "#5c6bc0" },
  hpp: { glyph: "code", color: "#5c6bc0" },
  cs: { glyph: "code", color: "#9b4f96" },
  lua: { glyph: "code", color: "#2c2d72" },
  dart: { glyph: "code", color: "#0175c2" },
  ex: { glyph: "code", color: "#6e4a7e" },
  exs: { glyph: "code", color: "#6e4a7e" },
  sh: { glyph: "terminal", color: C.shell },
  bash: { glyph: "terminal", color: C.shell },
  zsh: { glyph: "terminal", color: C.shell },
  fish: { glyph: "terminal", color: C.shell },
  ps1: { glyph: "terminal", color: "#4aa3d9" },
  bat: { glyph: "terminal", color: C.shell },
  cmd: { glyph: "terminal", color: C.shell },
  sql: { glyph: "database", color: C.db },
  db: { glyph: "database", color: C.db },
  sqlite: { glyph: "database", color: C.db },
  png: { glyph: "image", color: C.image },
  jpg: { glyph: "image", color: C.image },
  jpeg: { glyph: "image", color: C.image },
  gif: { glyph: "image", color: C.image },
  webp: { glyph: "image", color: C.image },
  ico: { glyph: "image", color: C.image },
  bmp: { glyph: "image", color: C.image },
  avif: { glyph: "image", color: C.image },
  tiff: { glyph: "image", color: C.image },
  zip: { glyph: "archive", color: C.archive },
  gz: { glyph: "archive", color: C.archive },
  tar: { glyph: "archive", color: C.archive },
  bz2: { glyph: "archive", color: C.archive },
  xz: { glyph: "archive", color: C.archive },
  "7z": { glyph: "archive", color: C.archive },
  rar: { glyph: "archive", color: C.archive },
  woff: { glyph: "font", color: C.font },
  woff2: { glyph: "font", color: C.font },
  ttf: { glyph: "font", color: C.font },
  otf: { glyph: "font", color: C.font },
  eot: { glyph: "font", color: C.font },
  lock: { glyph: "lock", color: C.default },
  key: { glyph: "lock", color: C.lock },
  pem: { glyph: "lock", color: C.lock },
  crt: { glyph: "lock", color: C.lock },
  cer: { glyph: "lock", color: C.lock },
  p12: { glyph: "lock", color: C.lock },
  pfx: { glyph: "lock", color: C.lock },
  wat: { glyph: "code", color: C.code },
  wasm: { glyph: "hash", color: C.default },
  bin: { glyph: "hash", color: C.default },
  exe: { glyph: "hash", color: C.default },
  dll: { glyph: "hash", color: C.default },
  so: { glyph: "hash", color: C.default },
  dylib: { glyph: "hash", color: C.default },
  log: { glyph: "file", color: C.default },
  csv: { glyph: "database", color: C.data },
  tsv: { glyph: "database", color: C.data },
  xlsx: { glyph: "database", color: "#26a269" },
  pdf: { glyph: "book", color: "#d64b4b" },
};

export function resolveIcon(
  name: string,
  isDirectory: boolean,
  expanded: boolean,
): { glyph: ReactNode; color: string } {
  if (isDirectory) {
    return { glyph: GLYPH[expanded ? "folderOpen" : "folder"], color: C.folder };
  }

  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return { glyph: GLYPH[byName.glyph], color: byName.color };

  // .env.local / .env.production 之类的变体
  if (lower.startsWith(".env")) return { glyph: GLYPH.lock, color: C.secret };

  const dot = lower.lastIndexOf(".");
  if (dot > 0 && dot < lower.length - 1) {
    const spec = BY_EXT[lower.slice(dot + 1)];
    if (spec) return { glyph: GLYPH[spec.glyph], color: spec.color };
  }

  return { glyph: GLYPH.file, color: C.default };
}

type Props = {
  name: string;
  isDirectory: boolean;
  expanded?: boolean;
  size?: number;
  className?: string;
};

export function FileIcon({ name, isDirectory, expanded = false, size = 15, className }: Props) {
  const { glyph, color } = resolveIcon(name, isDirectory, expanded);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ color, flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
