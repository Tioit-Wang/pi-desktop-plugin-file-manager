/**
 * 语法高亮的唯一来源。
 *
 * 编辑器和 Markdown 预览的代码块共用同一套 HighlightStyle，颜色因此永远一致；
 * 两处都跟随面板调色板（深/浅两套）。
 */

import { EditorState } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightTree, tags as t } from "@lezer/highlight";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { Base } from "./appearance";
import { resolveLanguage, resolveLanguageByName } from "./languages";

const COMMON_RULES = [
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], fontWeight: "600" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.link, t.url], textDecoration: "underline" },
];

export const darkHighlight = HighlightStyle.define([
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#7f848e", fontStyle: "italic" },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.number, t.bool, t.null], color: "#d19a66" },
  { tag: [t.variableName, t.propertyName], color: "#e06c75" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e06c75" },
  { tag: [t.tagName], color: "#e06c75" },
  { tag: [t.attributeName], color: "#d19a66" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#abb2bf" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "#61afef" },
  { tag: [t.link, t.url], color: "#56b6c2" },
  { tag: [t.meta], color: "#7f848e" },
  { tag: [t.invalid], color: "#ff6764" },
  ...COMMON_RULES,
]);

export const lightHighlight = HighlightStyle.define([
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#a0a1a7", fontStyle: "italic" },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#a626a4" },
  { tag: [t.string, t.special(t.string)], color: "#50a14f" },
  { tag: [t.number, t.bool, t.null], color: "#986801" },
  { tag: [t.variableName, t.propertyName], color: "#e45649" },
  { tag: [t.typeName, t.className, t.namespace], color: "#c18401" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#4078f2" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e45649" },
  { tag: [t.tagName], color: "#e45649" },
  { tag: [t.attributeName], color: "#986801" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#383a42" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "#4078f2" },
  { tag: [t.link, t.url], color: "#0184bc" },
  { tag: [t.meta], color: "#a0a1a7" },
  { tag: [t.invalid], color: "#e02e2a" },
  ...COMMON_RULES,
]);

export const highlightFor = (base: Base): HighlightStyle =>
  base === "light" ? lightHighlight : darkHighlight;

/** 编辑器用的扩展；HighlightStyle 生成的类名样式表由它注入。 */
export const highlightExtension = (base: Base) =>
  syntaxHighlighting(highlightFor(base), { fallback: true });

export type Token = { from: number; to: number; classes: string };

/**
 * 对一段代码做一次性高亮，返回 token 区间。
 * 只依赖 @codemirror/state 的 EditorState（不需要 DOM），
 * 因此 Markdown 预览和离线校验脚本都能直接用它。
 */
export async function tokenizeCode(
  code: string,
  hint: { fileName?: string; language?: string },
  base: Base,
): Promise<Token[]> {
  const description = hint.fileName
    ? resolveLanguage(hint.fileName)
    : hint.language
      ? resolveLanguageByName(hint.language)
      : null;
  if (!description) return [];

  const support = await description.load();
  const state = EditorState.create({ doc: code, extensions: [support] });

  const tokens: Token[] = [];
  highlightTree(syntaxTree(state), highlightFor(base), (from, to, classes) => {
    tokens.push({ from, to, classes });
  });
  return tokens;
}

/**
 * 把代码渲染成带高亮 class 的 React 节点。
 * 全部是 React 元素，没有 dangerouslySetInnerHTML——不存在注入面。
 */
export function renderHighlighted(code: string, tokens: Token[]): ReactNode[] {
  if (tokens.length === 0) return [code];

  const nodes: ReactNode[] = [];
  let cursor = 0;

  tokens.forEach((token, index) => {
    if (token.from > cursor) nodes.push(code.slice(cursor, token.from));
    nodes.push(
      createElement(
        "span",
        { key: `${token.from}-${index}`, className: token.classes },
        code.slice(token.from, token.to),
      ),
    );
    cursor = token.to;
  });

  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}
