import type { LiveTokenizer, LiveTextEdit } from '@pierre/highlights';
import type { Extension, Transaction } from '@codemirror/state';
import { Compartment, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

import { highlightTokensInWorker } from '@/components/chat/markdown/markdown-worker';
import type { CodeTokenTheme, MarkdownTokenRun } from '@/components/chat/markdown/markdown-worker-protocol';

// Syntax colors for CodeMirror that match the file view exactly. Inline mark
// styles override the lezer HighlightStyle, so the lezer language extension
// stays on for indentation, folding and brackets.
//
// Languages with a Highlights lexer tokenize on the main thread with its
// LiveTokenizer: an edit re-tokenizes only the lines it changed. Lines up to
// the end of the viewport finish before each paint, so colors land in the same
// frame as the keystroke; lines below continue in background batches and are
// finished when they scroll into view. Other languages, and
// runtimes where Highlights cannot start, tokenize the whole document in the
// shared code worker after a short idle; existing colors are mapped through
// edits in the meantime.

type CodeHighlightOptions = {
  /** Language id from `getLanguageFromExtension` (e.g. 'typescript'). */
  language: string;
  /** App theme id; the worker keys its loaded themes by it. */
  themeName: string;
  /** The app theme in both highlighter formats. */
  theme: CodeTokenTheme;
};

// Shiki FontStyle bitmask, which Highlights tokens share.
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

// ── Highlights: incremental, main thread ────────────────────────────────

/** CodeMirror changes as LSP-style edits against the pre-edit document. */
const toTextEdits = (tr: Transaction): LiveTextEdit[] => {
  const before = tr.startState.doc;
  const position = (offset: number) => {
    const line = before.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  };
  const edits: LiveTextEdit[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ range: { start: position(fromA), end: position(toA) }, newText: inserted.toString() });
  });
  return edits;
};

const visibleLines = (view: EditorView): [number, number] => {
  const { doc } = view.state;
  return [doc.lineAt(view.viewport.from).number - 1, doc.lineAt(view.viewport.to).number];
};

const liveHighlightPlugin = (createTokenizer: (code: string) => LiveTokenizer) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly tokenizer: LiveTokenizer;

      constructor(private readonly view: EditorView) {
        this.tokenizer = createTokenizer(view.state.doc.toString());
        this.decorations = this.build();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          for (const tr of update.transactions) {
            if (!tr.docChanged) continue;
            this.tokenizer.applyEdits(toTextEdits(tr), { renderRange: visibleLines(update.view) });
          }
          // Edits are validated against the tokenizer's copy; a mismatch would
          // color the wrong text, so start over from the editor's document.
          if (this.tokenizer.lineCount !== update.state.doc.lines) {
            this.tokenizer.reset(update.state.doc.toString(), { renderRange: visibleLines(update.view) });
          }
        }
        if (update.docChanged || update.viewportChanged) this.decorations = this.build();
      }

      private build(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const { doc } = this.view.state;
        const [start, end] = visibleLines(this.view);
        // Pending lines would show their previous colors until a background batch.
        this.tokenizer.flush(end);
        for (let index = start; index < Math.min(end, this.tokenizer.lineCount); index += 1) {
          const line = doc.line(index + 1);
          for (const token of this.tokenizer.getLineTokens(index).tokens) {
            const fontStyle = token.fontStyle ?? 0;
            if (!token.color && !fontStyle) continue;
            const from = line.from + token.offset;
            const to = Math.min(from + token.content.length, line.to);
            if (to > from) builder.add(from, to, markFor(token.color ?? '', fontStyle));
          }
        }
        return builder.finish();
      }

      destroy() {
        this.tokenizer.dispose();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

// ── Shiki: whole document in the worker ─────────────────────────────────

const RETOKENIZE_IDLE_MS = 180;

const setWorkerDecorations = StateEffect.define<DecorationSet>();

const buildWorkerDecorations = (view: EditorView, lines: MarkdownTokenRun[][]): DecorationSet => {
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

const workerDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    // Map existing colors through edits so they track the text while typing.
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setWorkerDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const workerHighlightPlugin = (options: CodeHighlightOptions) =>
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
        view.dispatch({ effects: setWorkerDecorations.of(buildWorkerDecorations(view, lines)) });
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

// ── Engine choice ───────────────────────────────────────────────────────

let highlightsModule: Promise<typeof import('@pierre/highlights') | null> | undefined;

/**
 * CodeMirror extension that colors the document like the file view. Recreate
 * it (new instance) when the language or theme changes.
 */
export const codeHighlightExtension = (options: CodeHighlightOptions): Extension => {
  // Highlights compiles its WebAssembly at import, so the engine is chosen
  // once the module resolves; until then the document shows plain text.
  const engine = new Compartment();
  const lang = options.language;
  const chooser = ViewPlugin.fromClass(class {
    private active = true;

    constructor(view: EditorView) {
      highlightsModule ??= import('@pierre/highlights').catch(() => null);
      void highlightsModule.then((highlights) => {
        if (!this.active) return;
        const live = highlights && highlights.isSupportedLanguage(lang)
          ? liveHighlightPlugin((code) => new highlights.LiveTokenizer({ code, lang, theme: options.theme.zed, renderRange: visibleLines(view) }))
          : null;
        view.dispatch({ effects: engine.reconfigure(live ?? [workerDecorationsField, workerHighlightPlugin(options)]) });
      });
    }

    destroy() {
      this.active = false;
    }
  });
  return [engine.of([]), chooser];
};
