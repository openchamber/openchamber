import type { EditorState, Extension, Line } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { symbolKindOf } from './documentSymbols';

// While the body of a function or class fills the screen, its first line
// stays pinned at the top of the editor, nested scopes under it, like VS
// Code's sticky scroll. The scopes come from the syntax tree, the same
// declarations the symbol list shows; a click scrolls to that line.

const MAX_STICKY_LINES = 3;

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/**
 * Lines that open the declarations still running at `pos` and starting above
 * `coveredFrom`, outermost first, at most `MAX_STICKY_LINES` of the innermost.
 */
export const enclosingScopeLines = (state: EditorState, pos: number, coveredFrom: number): Line[] => {
  const lines: Line[] = [];
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    const kind = symbolKindOf(node);
    if (!kind || kind === 'heading' || node.to <= pos) continue;
    const line = state.doc.lineAt(node.from);
    if (line.from >= coveredFrom || lines.some((known) => known.number === line.number)) continue;
    lines.unshift(line);
  }
  return lines.slice(-MAX_STICKY_LINES);
};

type StickyMeasure = {
  lines: Line[];
  lineHeight: number;
  /** Where the code starts, and where the line-number column ends. */
  gutterWidth: number;
  numbersEnd: number;
  scrollLeft: number;
  font: string;
  numberColor: string;
};

const stickyScopePlugin = ViewPlugin.fromClass(class {
  private readonly dom: HTMLElement;
  private shownKey = '';
  private readonly onScroll = () => this.measure();

  constructor(readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-sticky-scope';
    this.dom.setAttribute('dir', 'ltr');
    this.dom.hidden = true;
    view.dom.appendChild(this.dom);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.measure();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.measure();
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.dom.remove();
  }

  private measure(): void {
    this.view.requestMeasure({ key: this, read: (view) => this.read(view), write: (measure) => this.write(measure) });
  }

  private read(view: EditorView): StickyMeasure {
    const lineHeight = view.defaultLineHeight;
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const scopesAt = (height: number) => {
      const block = view.lineBlockAtHeight(Math.max(0, height));
      return enclosingScopeLines(view.state, block.from, block.from);
    };
    // The pinned lines cover the text under them, so ask again for the first
    // line still visible below them.
    const first = top > 0 ? scopesAt(top) : [];
    const lines = first.length > 0 ? scopesAt(top + first.length * lineHeight) : [];
    const gutters = view.dom.querySelector<HTMLElement>('.cm-gutters');
    const numbers = view.dom.querySelector<HTMLElement>('.cm-lineNumbers');
    return {
      lines,
      lineHeight,
      gutterWidth: gutters?.offsetWidth ?? 0,
      numbersEnd: numbers ? numbers.offsetLeft + numbers.offsetWidth : 0,
      scrollLeft: view.scrollDOM.scrollLeft,
      font: getComputedStyle(view.contentDOM).font,
      numberColor: numbers ? getComputedStyle(numbers).color : '',
    };
  }

  private write({ lines, lineHeight, gutterWidth, numbersEnd, scrollLeft, font, numberColor }: StickyMeasure): void {
    this.dom.hidden = lines.length === 0;
    this.dom.style.font = font;
    this.dom.style.tabSize = String(this.view.state.tabSize);
    this.dom.style.setProperty('--cm-sticky-gutter', `${gutterWidth}px`);
    this.dom.style.setProperty('--cm-sticky-numbers-end', `${numbersEnd}px`);
    this.dom.style.setProperty('--cm-sticky-scroll-left', `${-scrollLeft}px`);
    this.dom.style.setProperty('--cm-sticky-number-color', numberColor);
    const key = lines.map((line) => `${line.number}:${line.text}`).join('\n') + `@${lineHeight}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.dom.replaceChildren(...lines.map((line) => {
      const row = document.createElement('div');
      row.className = 'cm-sticky-scope-line';
      row.style.height = `${lineHeight}px`;
      row.style.lineHeight = `${lineHeight}px`;
      // The pinned line covers the gutter too, so it shows its own number
      // and not the one of the line hidden under it.
      const number = document.createElement('span');
      number.className = 'cm-sticky-scope-number';
      number.textContent = String(line.number);
      const code = document.createElement('span');
      code.className = 'cm-sticky-scope-code';
      code.textContent = line.text;
      row.append(number, code);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const current = this.view.state.doc.line(line.number);
        const indent = /^\s*/.exec(current.text)?.[0].length ?? 0;
        this.view.dispatch({
          selection: { anchor: current.from + indent },
          effects: EditorView.scrollIntoView(current.from, { y: 'start' }),
        });
        this.view.focus();
      });
      return row;
    }));
  }
});

export const stickyScope = (): Extension => [
  stickyScopePlugin,
  EditorView.theme({
    // Above the gutter too (z-index 2), from the editor's left edge.
    '.cm-sticky-scope': {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: 3,
      overflow: 'hidden',
      backgroundColor: 'inherit',
      borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
    },
    '.cm-sticky-scope-line': {
      display: 'flex',
      whiteSpace: 'pre',
      backgroundColor: 'inherit',
      cursor: 'pointer',
    },
    '.cm-sticky-scope-number': {
      flex: '0 0 var(--cm-sticky-gutter)',
      boxSizing: 'border-box',
      // Right-aligned where the line-number column ends, like the numbers below.
      paddingRight: 'calc(var(--cm-sticky-gutter) - var(--cm-sticky-numbers-end) + 8px)',
      textAlign: 'right',
      color: 'var(--cm-sticky-number-color)',
      backgroundColor: 'inherit',
      position: 'relative',
      zIndex: 1,
    },
    '.cm-sticky-scope-code': {
      paddingLeft: '6px',
      transform: 'translateX(var(--cm-sticky-scroll-left))',
    },
  }),
];
