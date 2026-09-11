/**
 * CodeMirror 6 编辑器。
 *
 * 不用 codemirror 的 basicSetup：它内部注册了
 * `syntaxHighlighting(defaultHighlightStyle, { fallback: true })`，
 * 与自己的 HighlightStyle 形成两个 fallback 高亮器，谁生效并不确定——
 * 这正是「代码没有高亮」的根因。这里改为显式组装扩展列表，
 * 高亮器只有一个，来自 ./highlight（与 Markdown 预览共用）。
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

import type { Base } from "./appearance";
import { highlightExtension } from "./highlight";
import { resolveLanguage } from "./languages";

const languageSlot = new Compartment();
const highlightSlot = new Compartment();
const readOnlySlot = new Compartment();

function baseExtensions(base: Base): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
    readOnlySlot.of([]),
    languageSlot.of([]),
    highlightSlot.of(highlightExtension(base)),
  ];
}

export type EditorHandle = {
  view: EditorView;
  setDocument(text: string, filePath: string, readOnly: boolean): void;
  setBase(base: Base): void;
  setReadOnly(readOnly: boolean): void;
  text(): string;
};

export function createEditor(
  parent: HTMLElement,
  options: {
    base: Base;
    onDocChanged: () => void;
    onSave: () => void;
  },
): EditorHandle {
  let languageToken = 0;
  // setDocument 本身也是一次 dispatch，会触发 updateListener；不抑制的话
  // 「打开文件」会立刻被当成有未保存改动。
  let suppressChanges = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        ...baseExtensions(options.base),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              options.onSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressChanges) options.onDocChanged();
        }),
      ],
    }),
  });

  const setReadOnly = (readOnly: boolean) => {
    view.dispatch({
      effects: readOnlySlot.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    });
  };

  return {
    view,
    text: () => view.state.doc.toString(),
    setBase(base) {
      view.dispatch({ effects: highlightSlot.reconfigure(highlightExtension(base)) });
    },
    setReadOnly,
    setDocument(text, filePath, readOnly) {
      languageToken += 1;
      const token = languageToken;

      suppressChanges = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
        });
      } finally {
        suppressChanges = false;
      }
      view.scrollDOM.scrollTop = 0;
      setReadOnly(readOnly);

      // 语言是同步可用的（静态 import），一次 dispatch 就配上。
      const description = resolveLanguage(filePath);
      if (!description) {
        view.dispatch({ effects: languageSlot.reconfigure([]) });
        return;
      }
      void description.load().then((support) => {
        // 加载期间用户可能已经切走，别把语言配到别的文件上。
        if (token !== languageToken) return;
        view.dispatch({ effects: languageSlot.reconfigure(support) });
      });
    },
  };
}
