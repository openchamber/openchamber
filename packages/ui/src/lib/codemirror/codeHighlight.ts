import type { LiveTokenizer, LiveTextEdit, Theme as ZedTheme } from '@pierre/highlights';
import type { Extension, Transaction } from '@codemirror/state';
import { Compartment, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

import { highlightsLanguage, loadHighlights } from '@/components/chat/markdown/highlightsEngine';


type CodeHighlightOptions = {
  language: string;
  theme: ZedTheme;
};

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

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

export const codeHighlightExtension = (options: CodeHighlightOptions): Extension => {
  const engine = new Compartment();
  const starter = ViewPlugin.fromClass(class {
    private active = true;

    constructor(view: EditorView) {
      void loadHighlights().then((highlights) => {
        if (!this.active || !highlights) return;
        const lang = highlightsLanguage(highlights, options.language);
        view.dispatch({
          effects: engine.reconfigure(liveHighlightPlugin((code) => (
            new highlights.LiveTokenizer({ code, lang, theme: options.theme, renderRange: visibleLines(view) })
          ))),
        });
      });
    }

    destroy() {
      this.active = false;
    }
  });
  return [engine.of([]), starter];
};
