import { invoke } from "./bridge";
import { channels, type Failure, type ReadResponse } from "./rpc";

/** Resolve only project-relative images; the receiver still enforces its file jail. */
export function markdownImagePath(source: string, filePath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]); }
  catch { return null; }
  const relative = (value: string) => value.length > 0 &&
    !/^[\\/]|^[a-z][a-z\d+.-]*:|[\x00-\x1f\x7f]/i.test(value);
  if (!relative(decoded) || !relative(filePath)) return null;
  const parts = filePath.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export async function loadMarkdownImage(
  source: string, filePath: string, workspacePath: string,
): Promise<string | null> {
  const path = markdownImagePath(source, filePath);
  if (!path || !workspacePath) return null;
  try {
    const response = await invoke<ReadResponse | Failure>(channels.read, { path, workspacePath });
    return response.ok && response.kind === "image" &&
      /^data:image\/[a-z\d.+-]+;base64,[a-z\d+/=]+$/i.test(response.dataUri)
      ? response.dataUri : null;
  } catch { return null; }
}
