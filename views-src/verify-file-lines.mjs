import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("./src/lib/file-line-selection.ts", import.meta.url))],
  format: "esm",
  write: false,
});
const { FILE_LINES_CLIPBOARD_TYPE, readFileLineSelection, appendFileLineClipboard } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);

const doc = Array.from({ length: 87 }, (_, index) => `line ${index + 1}`).join("\n");
const workspace = "/project";
const path = "/project/src/gpt.py";
const initial = EditorState.create({
  doc,
  extensions: [EditorState.allowMultipleSelections.of(true)],
});
const first = initial.doc.line(85);
const second = initial.doc.line(86);
const third = initial.doc.line(87);
const selected = (selection) =>
  readFileLineSelection(initial.update({ selection }).state, workspace, path, doc);

assert.equal(FILE_LINES_CLIPBOARD_TYPE, "application/x-pi-desktop-file-lines");
const reference = { workspace, path, start: 85, end: 86 };
const writes = [];
const clipboard = { types: ["text/plain"], setData: (...args) => writes.push(args) };
assert.equal(appendFileLineClipboard(clipboard, reference, false), false);
assert.equal(appendFileLineClipboard({ ...clipboard, types: [] }, reference, true), false);
assert.equal(writes.length, 0);
assert.equal(appendFileLineClipboard(clipboard, reference, true), true);
assert.deepEqual(writes, [[FILE_LINES_CLIPBOARD_TYPE, JSON.stringify(reference)]]);
assert.equal(appendFileLineClipboard({ ...clipboard, setData() { throw new Error("Clipboard denied"); } }, reference, true), false);
assert.deepEqual(selected({ anchor: third.from, head: first.from }), {
  workspace, path, start: 85, end: 86,
});
assert.deepEqual(selected({ anchor: first.from + 5, head: first.to }), {
  workspace, path, start: 85, end: 85,
});
assert.equal(selected({ anchor: first.from }), null);
assert.equal(selected(EditorSelection.create([
  EditorSelection.range(first.from, first.to),
  EditorSelection.range(second.from, second.to),
])), null);

const unsaved = initial.update({ changes: { from: 0, insert: "unsaved line\n" } }).state;
const shifted = unsaved.doc.line(86);
const shiftedSelection = unsaved.update({ selection: { anchor: shifted.from, head: shifted.to } }).state;
assert.equal(shifted.text, first.text);
assert.equal(readFileLineSelection(shiftedSelection, workspace, path, null), null);
assert.equal(readFileLineSelection(shiftedSelection, workspace, path, doc), null);
assert.deepEqual(readFileLineSelection(shiftedSelection, workspace, path, unsaved.doc.toString()), {
  workspace, path, start: 86, end: 86,
});

console.log("FILE LINES VERIFY PASSED: inclusive source lines, empty and multiple selections");
