/**
 * JSON 解析包装。
 *
 * 解析失败不是异常路径而是正常结果：.jsonc/.json5 带注释、tsconfig.json 里
 * 常有人写 // 注释、正在编辑的文件本来就可能是半截的——这些都应该显示成
 * 「解析失败 + 原因」，而不是把面板炸掉。
 */

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

export function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 折叠树里一行摘要用的短描述。 */
export function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `${value.length}`;
  if (typeof value === "object") return `${Object.keys(value as object).length}`;
  return typeof value;
}
