import type { EditorState } from "@codemirror/state";

export const FILE_LINES_CLIPBOARD_TYPE = "application/x-pi-desktop-file-lines";

export type FileLineReference = {
  workspace: string;
  path: string;
  start: number;
  end: number;
};

export function appendFileLineClipboard(
  clipboard: Pick<DataTransfer, "types" | "setData">,
  reference: FileLineReference,
  plainTextHandled: boolean,
): boolean {
  if (!plainTextHandled || !clipboard.types.includes("text/plain")) return false;
  try {
    clipboard.setData(FILE_LINES_CLIPBOARD_TYPE, JSON.stringify(reference));
    return true;
  } catch {
    return false;
  }
}

export function readFileLineSelection(
  state: EditorState,
  workspace: string,
  path: string,
  savedText: string | null,
): FileLineReference | null {
  if (savedText === null || state.selection.ranges.length !== 1 || state.selection.main.empty ||
      state.doc.toString() !== savedText) return null;
  const { from, to } = state.selection.main;
  return {
    workspace,
    path,
    start: state.doc.lineAt(from).number,
    end: state.doc.lineAt(to - 1).number,
  };
}
