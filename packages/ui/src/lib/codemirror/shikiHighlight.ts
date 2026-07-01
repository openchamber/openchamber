import type { Extension } from '@codemirror/state';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

import { highlightTokensInWorker } from '@/components/chat/markdown/markdown-worker';
import type { MarkdownTokenRun } from '@/components/chat/markdown/markdown-worker-protocol';

// Shiki-powered syntax highlighting for CodeMirror, matching the Shiki file
// view exactly: tokenize the whole document in the markdown Shiki worker (off
// the main thread) and project the tokens onto mark decorations.
//
// While typing, existing decorations are mapped through edits so colors stay put
// (no flash); the document is re-tokenized on a short idle, never on the hot
// keystroke path. Decoration inline styles override the lezer HighlightStyle, so
// the lezer language extension can stay on for indentation/folding/brackets.

const RETOKENIZE_IDLE_MS = 180;

const setShikiDecorations = StateEffect.define<DecorationSet>();

// Shiki FontStyle bitmask.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

// Mark decorations are interned by color+style so repeated tokens reuse one spec.
const markCache = new Map<string, Decoration>();

const markFor = (color: string, fontStyle: number): Decoration => {
  const key = `${color}|${fontStyle}`;
  const cached = markCache.get(key);
  if (cached) return cached;
  let style = '';
  if (color) style += `color:${color};`;
  if (fontStyle & FONT_STYLE_ITALIC) style += 'font-style:italic;';
  if (fontStyle & FONT_STYLE_BOLD) style += 'font-weight:bold;';
  if (fontStyle & FONT_STYLE_UNDERLINE) style += 'text-decoration:underline;';
  const decoration = Decoration.mark({ attributes: { style } });
  markCache.set(key, decoration);
  return decoration;
};

const buildDecorations = (view: EditorView, lines: MarkdownTokenRun[][]): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const count = Math.min(lines.length, doc.lines);
  for (let i = 0; i < count; i += 1) {
    const runs = lines[i];
    if (!runs || runs.length === 0) continue;
    const line = doc.line(i + 1);
    let pos = line.from;
    for (const [length, color, fontStyle] of runs) {
      if (length <= 0) continue;
      const from = pos;
      const to = Math.min(pos + length, line.to);
      pos += length;
      if (to <= from) continue;
      if (!color && !fontStyle) continue;
      builder.add(from, to, markFor(color, fontStyle));
    }
  }
  return builder.finish();
};

const shikiDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    // Map existing colors through edits so they track the text while typing.
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setShikiDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

type ShikiHighlightOptions = {
  /** Shiki language id (e.g. 'typescript'). */
  language: string;
  /** App theme id — the registered TextMate theme name to tokenize with. */
  themeName: string;
  /** Resolved TextMate theme object (shipped to the worker once per name). */
  theme: unknown;
};

const shikiHighlightPlugin = (options: ShikiHighlightOptions) =>
  ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private generation = 0;

      constructor(view: EditorView) {
        void this.tokenize(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.schedule(update.view);
      }

      private schedule(view: EditorView) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.tokenize(view);
        }, RETOKENIZE_IDLE_MS);
      }

      private async tokenize(view: EditorView) {
        const generation = ++this.generation;
        const text = view.state.doc.toString();
        const lines = await highlightTokensInWorker(text, options.language, options.themeName, options.theme);
        if (!lines) return;
        // Drop if a newer tokenization started or the doc length changed since.
        if (generation !== this.generation) return;
        if (view.state.doc.length !== text.length) return;
        view.dispatch({ effects: setShikiDecorations.of(buildDecorations(view, lines)) });
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

/**
 * CodeMirror extension that colors the document with Shiki tokens via the
 * worker. Recreate it (new instance) when the language or theme changes.
 */
export const shikiHighlightExtension = (options: ShikiHighlightOptions): Extension => [
  shikiDecorationsField,
  shikiHighlightPlugin(options),
];
