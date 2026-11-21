import type { EditorState, Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';

type CodeSelectionQuote = { from: number; to: number; code: string; startLine: number; endLine: number };

export const readCodeSelectionQuote = (state: EditorState): CodeSelectionQuote | null => {
  const { ranges } = state.selection;
  if (ranges.length !== 1 || ranges[0].empty) return null;
  const { from, to } = ranges[0];
  const last = state.doc.lineAt(to);
  const endLine = to === last.from ? last.number - 1 : last.number;
  return { from, to, code: state.doc.sliceString(from, to), startLine: state.doc.lineAt(from).number, endLine };
};

type Anchor = { x: number; y: number };
type DisplayRange = { from: number; to: number };

type CodeSelectionMenuState = {
  view: EditorView;
  filePath: string;
  quote: CodeSelectionQuote;
  range: DisplayRange | null;
  anchor: Anchor | null;
  commentMode: boolean;
  highlightRects: DOMRect[] | null;
};

const anchorFor = (view: EditorView, { from, to }: DisplayRange): Anchor | null => {
  const box = view.scrollDOM.getBoundingClientRect();
  const onScreen = (coords: { top: number; bottom: number } | null) => coords !== null && coords.bottom > box.top && coords.top < box.bottom;
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  const screenTop = () => view.coordsAtPos(Math.min(Math.max(view.posAtCoords({ x: box.left + 1, y: box.top + 1 }, false), from), to), 1);
  const line = [start, end].find(onScreen) ?? [screenTop()].find(onScreen);
  if (!line) return null;
  const x = start && end && start.top === end.top ? (start.left + end.right) / 2 : line.left;
  return { x: Math.min(Math.max(x, box.left + 60), box.right - 60), y: line.top - 8 };
};

const highlightRectsFor = (view: EditorView, range: DisplayRange | null): DOMRect[] | null => {
  if (view.dom.querySelector('.cm-selectionLayer')) return null;
  if (!range) return [];
  const from = Math.max(range.from, view.viewport.from);
  const to = Math.min(range.to, view.viewport.to);
  if (from >= to) return [];
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  const domRange = document.createRange();
  domRange.setStart(start.node, start.offset);
  domRange.setEnd(end.node, end.offset);
  const box = view.scrollDOM.getBoundingClientRect();
  return collectSelectionOverlayRects(domRange).filter((rect) => rect.bottom > box.top && rect.top < box.bottom);
};

const mapRange = ({ from, to }: DisplayRange, code: string, update: ViewUpdate): DisplayRange | null => {
  const mapped = { from: update.changes.mapPos(from, 1), to: update.changes.mapPos(to, -1) };
  if (mapped.from < mapped.to) return mapped;
  const text = update.state.doc.toString();
  let nearest: number | null = null;
  for (let at = text.indexOf(code); at !== -1; at = text.indexOf(code, at + 1)) {
    if (nearest === null || Math.abs(at - from) < Math.abs(nearest - from)) nearest = at;
  }
  return nearest === null ? null : { from: nearest, to: nearest + code.length };
};

export class CodeSelectionComments {
  private state: CodeSelectionMenuState | null = null;
  private filePath: string | null = null;
  private readonly listeners = new Set<() => void>();
  private menu: HTMLElement | null = null;
  private stopTracking: (() => void) | null = null;
  private readonly measureKey = {};

  readonly extension: Extension = ViewPlugin.define((view) => ({
    update: (update) => {
      if (update.selectionSet || update.docChanged || update.focusChanged || update.geometryChanged) this.editorChanged(update);
    },
    destroy: () => {
      if (this.state?.view === view) this.hide();
    },
  }));

  readonly getSnapshot = () => this.state;

  attach(filePath: string | null, notify: () => void) {
    this.filePath = filePath;
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
      this.filePath = null;
      this.hide();
    };
  }

  readonly setMenu = (element: HTMLDivElement | null) => {
    this.menu = element;
  };

  readonly openComment = () => {
    if (!this.state) return;
    this.publish({ ...this.state, commentMode: true });
    this.measure(this.state.view);
  };

  readonly hide = () => {
    if (!this.state) return;
    this.publish(null);
  };

  private editorChanged(update: ViewUpdate) {
    const { view } = update;
    const current = this.state;
    if (current?.commentMode) {
      if (current.view !== view) return;
      if (update.docChanged && current.range) this.publish({ ...current, range: mapRange(current.range, current.quote.code, update) });
      if (update.docChanged || update.geometryChanged) this.measure(view);
      return;
    }
    if (!view.hasFocus && current?.view !== view) return;
    const quote = readCodeSelectionQuote(view.state);
    if (!quote || !this.filePath) {
      this.hide();
      return;
    }
    const same = current?.view === view && current.filePath === this.filePath && current.quote.from === quote.from
      && current.quote.to === quote.to && current.quote.code === quote.code;
    if (!same) {
      this.publish({ view, filePath: this.filePath, quote, range: { from: quote.from, to: quote.to }, anchor: current?.view === view ? current.anchor : null, commentMode: false, highlightRects: null });
    }
    this.measure(view);
  }

  private measure(view: EditorView) {
    view.requestMeasure({
      key: this.measureKey,
      read: () => {
        const current = this.state;
        if (current?.view !== view) return null;
        return { anchor: current.range && anchorFor(view, current.range), highlightRects: current.commentMode ? highlightRectsFor(view, current.range) : null };
      },
      write: (measured) => {
        const current = this.state;
        if (!measured || current?.view !== view) return;
        const anchor = measured.anchor ?? (current.commentMode ? current.anchor : null);
        if (anchor?.x === current.anchor?.x && anchor?.y === current.anchor?.y && !measured.highlightRects && !current.highlightRects) return;
        this.publish({ ...current, anchor, highlightRects: measured.highlightRects });
      },
    });
  }

  private publish(next: CodeSelectionMenuState | null) {
    if (next?.view !== this.state?.view) {
      this.stopTracking?.();
      this.stopTracking = next ? this.track(next.view) : null;
    }
    this.state = next;
    for (const notify of this.listeners) notify();
  }

  private track(view: EditorView) {
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || this.menu?.contains(event.target)) return;
      const pressed = event.target instanceof Element ? event.target : event.target.parentElement;
      const fieldSuggestions = pressed?.closest('.oc-inline-picker');
      const editorScrollbar = pressed?.closest('.overlay-scrollbar')?.parentElement?.parentElement?.contains(view.dom);
      if (fieldSuggestions || editorScrollbar) return;
      if (!this.state?.commentMode && view.contentDOM.contains(event.target)) return;
      this.hide();
    };
    const remeasure = () => this.measure(view);
    document.addEventListener('pointerdown', handlePointerDown, true);
    view.scrollDOM.addEventListener('scroll', remeasure, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      view.scrollDOM.removeEventListener('scroll', remeasure);
    };
  }
}
