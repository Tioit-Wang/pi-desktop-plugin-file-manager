/**
 * 「这个文件有哪几种看法」的唯一判定点。
 *
 * 判定放在视图侧（按文件名），而不是主进程返回一个新的 kind：文本类文件
 * 无论怎么看，字节都是同一份文本，主进程没必要知道用户当前想用表格还是
 * 源码看它——这和 Markdown 预览的处理方式一致。
 *
 * 上一轮修过的问题在这里同样适用：解析器与判定函数都必须是纯函数，
 * 好让 verify-viewers.mjs 能离线断言。
 */

import type { CopyKey } from "../i18n";
import { isMarkdown } from "./languages";

export type ViewerMode = "source" | "markdown" | "table" | "tree";

export type ViewerView = {
  /** 工具栏切换器里的顺序；只有一项时不该出现切换器。 */
  modes: ViewerMode[];
  mode: ViewerMode;
};

/** 切换器按钮文案。源码视图沿用既有的「编辑」，不再新增同义词。 */
export const MODE_LABEL: Record<ViewerMode, CopyKey> = {
  source: "editMode",
  markdown: "previewMode",
  table: "tableMode",
  tree: "treeMode",
};

export function csvDelimiterOf(filePath: string): "," | "\t" | null {
  if (/\.csv$/i.test(filePath)) return ",";
  if (/\.tsv$/i.test(filePath)) return "\t";
  return null;
}

export function isJson(filePath: string): boolean {
  return /\.(?:json|jsonc|json5)$/i.test(filePath);
}

export type ViewerPrefs = {
  mdPreview: boolean;
  csvTable: boolean;
  jsonTree: boolean;
};

export function resolveViewer(filePath: string, prefs: ViewerPrefs): ViewerView | null {
  if (isMarkdown(filePath)) {
    return { modes: ["source", "markdown"], mode: prefs.mdPreview ? "markdown" : "source" };
  }
  if (csvDelimiterOf(filePath)) {
    return { modes: ["source", "table"], mode: prefs.csvTable ? "table" : "source" };
  }
  if (isJson(filePath)) {
    return { modes: ["source", "tree"], mode: prefs.jsonTree ? "tree" : "source" };
  }
  return null;
}
