/**
 * Markdown 渲染器（预览模式用）。
 *
 * 刻意不用 marked / markdown-it + dangerouslySetInnerHTML：
 * 本视图是沙箱页面，但它的 bridge 通向一个能读写项目文件的插件主进程，
 * 所以预览里的 XSS 等价于任意文件写入。这里全部产出 React 元素，
 * 节点由 React 转义，**结构上不存在注入面**——不需要额外的 sanitizer。
 *
 * 支持：ATX 标题、围栏代码块（带语法高亮）、引用、分隔线、有序/无序/任务
 * 列表（按缩进嵌套）、表格、以及行内的 code / 粗体 / 斜体 / 删除线 / 链接 /
 * 图片。图片不加载（面板是 file://，相对路径指向视图自身），渲染为占位说明。
 */

import { useEffect, useState, type ReactNode } from "react";
import { createElement, Fragment } from "react";

import type { Base } from "./appearance";
import { renderHighlighted, tokenizeCode } from "./highlight";
import { isSafeLink } from "./linkSafety";

// ── 行内 ────────────────────────────────────────────────────────────────────

const INLINE_SOURCE = [
  "(`+)([\\s\\S]*?)\\1", // 1,2 行内代码
  "!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 3,4 图片
  "\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 5,6 链接
  "<((?:https?|mailto):[^>\\s]+)>", // 7 自动链接
  "\\*\\*([\\s\\S]+?)\\*\\*", // 8 粗体
  "__([\\s\\S]+?)__", // 9 粗体
  "~~([\\s\\S]+?)~~", // 10 删除线
  "(?<![*\\w])\\*([^*\\n]+?)\\*(?!\\*)", // 11 斜体
  "(?<![_\\w])_([^_\\n]+?)_(?!_)", // 12 斜体
].join("|");

/**
 * 每次调用都要新建正则。带 g 的正则是有状态的（lastIndex），而 renderInline
 * 会递归处理嵌套强调；共用同一个实例时内层调用会把 lastIndex 重置，
 * 外层循环因此永远走不到结尾——表现为预览卡死并吃光内存。
 */
const newInlinePattern = () => new RegExp(INLINE_SOURCE, "g");

type InlineContext = {
  base: Base;
  onLink: (url: string) => void;
  keyPrefix: string;
};

function renderInline(text: string, context: InlineContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = newInlinePattern();
  let cursor = 0;
  let index = 0;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const key = `${context.keyPrefix}-i${index++}`;
    const [
      ,
      fence,
      codeBody,
      imageAlt,
      imageSrc,
      linkText,
      linkHref,
      autolink,
      boldA,
      boldB,
      strike,
      emA,
      emB,
    ] = match;

    if (fence !== undefined) {
      nodes.push(createElement("code", { key, className: "md-inline-code" }, codeBody));
    } else if (imageSrc !== undefined) {
      // 面板以 file:// 加载，相对路径指向视图目录，图片无法加载；
      // 与其显示一个破图，不如给出可读的占位。
      nodes.push(
        createElement(
          "span",
          { key, className: "md-image", title: imageSrc },
          `🖼 ${imageAlt || imageSrc}`,
        ),
      );
    } else if (linkHref !== undefined) {
      nodes.push(renderLink(linkHref, renderInline(linkText ?? "", { ...context, keyPrefix: key }), key, context));
    } else if (autolink !== undefined) {
      nodes.push(renderLink(autolink, autolink, key, context));
    } else if (boldA !== undefined || boldB !== undefined) {
      nodes.push(
        createElement(
          "strong",
          { key },
          ...renderInline(boldA ?? boldB ?? "", { ...context, keyPrefix: key }),
        ),
      );
    } else if (strike !== undefined) {
      nodes.push(
        createElement("del", { key }, ...renderInline(strike, { ...context, keyPrefix: key })),
      );
    } else if (emA !== undefined || emB !== undefined) {
      nodes.push(
        createElement("em", { key }, ...renderInline(emA ?? emB ?? "", { ...context, keyPrefix: key })),
      );
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderLink(
  href: string,
  children: ReactNode,
  key: string,
  context: InlineContext,
): ReactNode {
  const safe = isSafeLink(href);
  return createElement(
    "a",
    {
      key,
      className: safe ? "md-link" : "md-link md-link-unsafe",
      href: undefined,
      title: safe ? `${href}（点击复制/提示，不跳转）` : `${href}（不支持的链接协议）`,
      role: "link",
      tabIndex: 0,
      onClick: (event: React.MouseEvent) => {
        event.preventDefault();
        context.onLink(href);
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          context.onLink(href);
        }
      },
    },
    ...(Array.isArray(children) ? children : [children]),
  );
}

// ── 代码块 ──────────────────────────────────────────────────────────────────

function CodeBlock({ code, language, base }: { code: string; language: string; base: Base }) {
  const [nodes, setNodes] = useState<ReactNode[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.replace(/\n$/, "");

    if (!language) {
      setNodes([trimmed]);
      return;
    }

    tokenizeCode(trimmed, { language }, base)
      .then((tokens) => {
        if (cancelled) return;
        setNodes(tokens.length ? renderHighlighted(trimmed, tokens) : [trimmed]);
      })
      .catch(() => {
        if (!cancelled) setNodes([trimmed]);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language, base]);

  return createElement(
    "pre",
    { className: "md-code" },
    createElement("code", null, ...(nodes ?? [code.replace(/\n$/, "")])),
  );
}

// ── 块级 ────────────────────────────────────────────────────────────────────

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "hr" }
  | { kind: "quote"; lines: string[] }
  | { kind: "para"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "table"; head: string[]; align: Array<"left" | "center" | "right" | null>; rows: string[][] };

type ListItem = { text: string; task: boolean | null; children: Block[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```+|~~~+)\s*([^`\s]*)\s*$/;
const HR = /^(?: {0,3})([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_ROW = /^\s*\|?(.*?)\|?\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const language = fence[2];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾围栏
      blocks.push({ kind: "code", language, code: body.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (QUOTE.test(lines[index]) || (body.length > 0 && lines[index].trim()))) {
        const quoted = QUOTE.exec(lines[index]);
        body.push(quoted ? quoted[1] : lines[index]);
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: ListItem[] = [];
      let itemLines: string[] = [];
      let itemTask: boolean | null = null;

      const flush = () => {
        if (itemLines.length === 0) return;
        items.push({ text: itemLines[0], task: itemTask, children: parseBlocks(itemLines.slice(1)) });
        itemLines = [];
        itemTask = null;
      };

      const baseIndent = (BULLET.exec(line) ?? ORDERED.exec(line))![1].length;
      while (index < lines.length) {
        const current = lines[index];
        if (!current.trim()) {
          // 空行只在后面还有同级条目时才属于本列表。
          const next = lines[index + 1] ?? "";
          const nextIsItem = ordered ? ORDERED.test(next) : BULLET.test(next);
          if (!nextIsItem) break;
          index += 1;
          continue;
        }

        const match = (ordered ? ORDERED : BULLET).exec(current);
        const indent = (BULLET.exec(current) ?? ORDERED.exec(current))?.[1].length ?? Infinity;
        if (match && indent <= baseIndent + 1) {
          flush();
          let content = match[3];
          const task = TASK.exec(content);
          if (task) {
            itemTask = task[1].toLowerCase() === "x";
            content = task[2];
          }
          itemLines = [content];
          index += 1;
          continue;
        }
        if (!match && indent < baseIndent + 1 && !current.startsWith(" ")) break;
        if (itemLines.length === 0) break;
        itemLines.push(current.replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
        index += 1;
      }
      flush();
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      const head = splitTableRow(line);
      const align = splitTableRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center" as const;
        if (right) return "right" as const;
        if (left) return "left" as const;
        return null;
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", head, align, rows });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index];
      if (
        FENCE.test(current) ||
        HR.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length) blocks.push({ kind: "para", lines: paragraph });
  }

  return blocks;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function renderBlocks(blocks: Block[], context: InlineContext, base: Base): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${context.keyPrefix}-b${index}`;

    switch (block.kind) {
      case "heading":
        return createElement(
          `h${Math.min(block.level, 6)}`,
          { key, className: `md-h${Math.min(block.level, 6)}` },
          ...renderInline(block.text, { ...context, keyPrefix: key }),
        );

      case "code":
        return createElement(CodeBlock, { key, code: block.code, language: block.language, base });

      case "hr":
        return createElement("hr", { key, className: "md-hr" });

      case "quote":
        return createElement(
          "blockquote",
          { key, className: "md-quote" },
          ...renderBlocks(parseBlocks(block.lines), { ...context, keyPrefix: key }, base),
        );

      case "list": {
        const children = block.items.map((item, itemIndex) => {
          const itemKey = `${key}-it${itemIndex}`;
          const content: ReactNode[] = [];
          if (item.task !== null) {
            content.push(
              createElement("input", {
                key: `${itemKey}-cb`,
                type: "checkbox",
                checked: item.task,
                readOnly: true,
                tabIndex: -1,
                className: "md-task",
              }),
            );
          }
          content.push(
            createElement(
              "span",
              { key: `${itemKey}-tx` },
              ...renderInline(item.text, { ...context, keyPrefix: itemKey }),
            ),
          );
          if (item.children.length) {
            content.push(...renderBlocks(item.children, { ...context, keyPrefix: itemKey }, base));
          }
          return createElement(
            "li",
            { key: itemKey, className: item.task !== null ? "md-li md-li-task" : "md-li" },
            ...content,
          );
        });
        return createElement(block.ordered ? "ol" : "ul", { key, className: "md-list" }, ...children);
      }

      case "table":
        return createElement(
          "div",
          { key, className: "md-table-wrap" },
          createElement(
            "table",
            { className: "md-table" },
            createElement(
              "thead",
              null,
              createElement(
                "tr",
                null,
                ...block.head.map((cell, cellIndex) =>
                  createElement(
                    "th",
                    {
                      key: `${key}-h${cellIndex}`,
                      style: block.align[cellIndex] ? { textAlign: block.align[cellIndex]! } : undefined,
                    },
                    ...renderInline(cell, { ...context, keyPrefix: `${key}-h${cellIndex}` }),
                  ),
                ),
              ),
            ),
            createElement(
              "tbody",
              null,
              ...block.rows.map((row, rowIndex) =>
                createElement(
                  "tr",
                  { key: `${key}-r${rowIndex}` },
                  ...block.head.map((_, cellIndex) =>
                    createElement(
                      "td",
                      {
                        key: `${key}-r${rowIndex}c${cellIndex}`,
                        style: block.align[cellIndex] ? { textAlign: block.align[cellIndex]! } : undefined,
                      },
                      ...renderInline(row[cellIndex] ?? "", {
                        ...context,
                        keyPrefix: `${key}-r${rowIndex}c${cellIndex}`,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

      case "para":
      default:
        return createElement(
          "p",
          { key, className: "md-p" },
          ...renderInline(block.lines.join("\n"), { ...context, keyPrefix: key }),
        );
    }
  });
}

export function MarkdownPreview({
  text,
  base,
  onLink,
}: {
  text: string;
  base: Base;
  onLink: (url: string) => void;
}) {
  const blocks = parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
  return createElement(
    Fragment,
    null,
    ...renderBlocks(blocks, { base, onLink, keyPrefix: "md" }, base),
  );
}
