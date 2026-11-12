import type { EditorState, Extension, Line, Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// A faint vertical line per indentation level, like the file tree's guides.
// Each visible line gets a background drawn at multiples of the file's own
// indent width, measured in `ch`, so the lines fall under the indentation
// whatever the font. Only lines in view are decorated.

// Lines read when guessing the indent width, and how far a blank line looks
// for a neighbour with text.
const DETECT_LINE_LIMIT = 2_000;
const BLANK_LOOKAROUND_LIMIT = 100;
const COMMON_WIDTHS = [2, 3, 4, 8];

/** Columns of leading whitespace, tabs counted to the next tab stop; null for a blank line. */
export const leadingColumns = (text: string, tabSize: number): number | null => {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += tabSize - (columns % tabSize);
    else return columns;
  }
  return null;
};

/**
 * The file's indent width in columns: the most common step between the
 * indentation of consecutive lines, among the usual widths. A file indented
 * with tabs steps by the tab size.
 */
export const detectIndentWidth = (doc: Text, tabSize: number): number => {
  const votes = new Map<number, number>();
  let previous = 0;
  const lines = Math.min(doc.lines, DETECT_LINE_LIMIT);
  for (let number = 1; number <= lines; number += 1) {
    const columns = leadingColumns(doc.line(number).text, tabSize);
    if (columns === null) continue;
    const step = Math.abs(columns - previous);
    previous = columns;
    if (COMMON_WIDTHS.includes(step)) votes.set(step, (votes.get(step) ?? 0) + 1);
  }
  let best = COMMON_WIDTHS[0];
  for (const [width, count] of votes) {
    if (count > (votes.get(best) ?? 0)) best = width;
  }
  return best;
};

const nearestTextColumns = (doc: Text, from: Line, direction: 1 | -1, tabSize: number): number | null => {
  for (let step = 1, number = from.number + direction; step <= BLANK_LOOKAROUND_LIMIT; step += 1, number += direction) {
    if (number < 1 || number > doc.lines) return null;
    const columns = leadingColumns(doc.line(number).text, tabSize);
    if (columns !== null) return columns;
  }
  return null;
};

/**
 * Guides a line shows: one per full indent step of its text. A blank line
 * takes the deeper of its neighbours, so the guides run through it.
 */
export const guideLevel = (doc: Text, line: Line, width: number, tabSize: number): number => {
  let columns = leadingColumns(line.text, tabSize);
  if (columns === null) {
    const above = nearestTextColumns(doc, line, -1, tabSize);
    const below = nearestTextColumns(doc, line, 1, tabSize);
    columns = Math.max(above ?? 0, below ?? 0);
  }
  return Math.floor(columns / width);
};

const guideDecorations = new Map<string, Decoration>();
const guideDecoration = (level: number, width: number): Decoration => {
  const key = `${level}:${width}`;
  let decoration = guideDecorations.get(key);
  if (!decoration) {
    decoration = Decoration.line({
      class: 'cm-indent-guides',
      attributes: { style: `--cm-indent-guides: ${level}; --cm-indent-width: ${width}` },
    });
    guideDecorations.set(key, decoration);
  }
  return decoration;
};

const buildGuides = (view: EditorView, state: EditorState, width: number): DecorationSet => {
  const { doc, tabSize } = state;
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      const level = guideLevel(doc, line, width, tabSize);
      if (level > 0) ranges.push(guideDecoration(level, width).range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges);
};

const guidesPlugin = ViewPlugin.fromClass(class {
  width: number;
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.width = detectIndentWidth(view.state.doc, view.state.tabSize);
    this.decorations = buildGuides(view, view.state, this.width);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.width = detectIndentWidth(update.state.doc, update.state.tabSize);
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildGuides(update.view, update.state, this.width);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export const indentGuides = (): Extension => [
  guidesPlugin,
  EditorView.theme({
    // Guides sit at columns 0, w, 2w… of the text, so the lines fall in the
    // indentation and never under the line's own first character. Their tone
    // comes from the editor's own text colour: the code background differs
    // from the page, so the file tree's border tone barely shows on it.
    '.cm-indent-guides': {
      backgroundImage: 'repeating-linear-gradient(to right, color-mix(in srgb, currentColor 16%, transparent) 0 1px, transparent 1px calc(var(--cm-indent-width) * 1ch))',
      backgroundSize: 'calc(var(--cm-indent-guides) * var(--cm-indent-width) * 1ch) 100%',
      backgroundRepeat: 'no-repeat',
      backgroundOrigin: 'content-box',
    },
  }),
];
