import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
Object.assign(globalThis, {
  // CodeMirror's measuring checks `instanceof Window`.
  Window,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { EditorView } = await import('@codemirror/view');
const { CodeMirrorEditor } = await import('@/components/ui/CodeMirrorEditor');
const { useLineNumberDragSelection } = await import('./useLineNumberDragSelection');

type LineRange = { start: number; end: number };
type Drag = ReturnType<typeof useLineNumberDragSelection>;

const DOC = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
// The editor's visible box: 10 lines tall, starting at the top of the page.
const VISIBLE_LINES = 10;

let container: HTMLDivElement;
let root: Root;
let view: InstanceType<typeof EditorView> | null;
let selection: LineRange | null;
let drag: Drag | null;
let clears: number;
let scrollTop: number;

const Host = ({ initialSelection = null }: { initialSelection?: LineRange | null }) => {
  const [lineSelection, setLineSelection] = React.useState<LineRange | null>(initialSelection);
  const result = useLineNumberDragSelection({
    lineSelection,
    setLineSelection,
    onClear: () => { clears += 1; },
    isMobile: false,
  });
  selection = lineSelection;
  drag = result;
  return (
    <CodeMirrorEditor
      value={DOC}
      onChange={() => {}}
      lineNumbersConfig={result.lineNumbersConfig}
      onViewReady={(ready) => { view = ready; }}
    />
  );
};

const render = async (initialSelection: LineRange | null = null) => {
  await act(async () => root.render(<Host initialSelection={initialSelection} />));
  const editor = view;
  if (!editor) throw new Error('editor did not mount');
  // happy-dom lays nothing out: give the scroller a box and a scroll position
  // that moves the document, as a browser would.
  const lineHeight = editor.defaultLineHeight;
  Object.defineProperty(editor.scrollDOM, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: VISIBLE_LINES * lineHeight, left: 0, right: 400, width: 400, height: VISIBLE_LINES * lineHeight }),
  });
  Object.defineProperty(editor.scrollDOM, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 90 * lineHeight)); },
  });
  Object.defineProperty(editor, 'documentTop', { get: () => -scrollTop });
  return editor;
};

// Page y of the middle of a line while the editor is scrolled to the top.
const lineY = (editor: InstanceType<typeof EditorView>, line: number) => (line - 0.5) * editor.defaultLineHeight;

// The dispatch helpers run synchronously on purpose, and act's thenable is
// never returned or awaited from them. The tests read what the handlers did
// before any timer has run; awaiting an act crosses macrotask turns (React's
// scheduler flushes through MessageChannel), where the hook's queued timers
// fire first and the read is no longer the one the test claims to make.
const pressLineNumber = (editor: InstanceType<typeof EditorView>, line: number, init: { shiftKey?: boolean } = {}) => {
  const gutter = editor.dom.querySelector('.cm-gutter.cm-lineNumbers');
  if (!gutter) throw new Error('no line-number gutter');
  act(() => {
    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: lineY(editor, line), ...init }));
  });
};

const moveTo = (clientX: number, clientY: number) => {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, buttons: 1 }));
  });
};

const release = () => {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  });
};

// The hook clears the release-click marker on the window's own timer queue, so
// that queue is where its clear is settled: both timers being 0 ms, the clear
// was queued first and must run first. A global-timer wait instead races the
// two queues, which happy-dom and Bun keep separately.
const settleReleaseClick = async () => {
  await act(async () => {
    await new Promise((resolve) => { dom.setTimeout(() => resolve(undefined), 0); });
  });
};

// One settled tick can run one or more of the auto-scroll's queued frames, so
// the tests below never assume one tick is one frame; they read the scroll
// position the rounds actually produced.
const settleScrollTicks = async (ticks: number) => {
  await act(async () => {
    for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => { setTimeout(() => resolve(undefined), 0); });
  });
};

beforeEach(() => {
  view = null;
  selection = null;
  drag = null;
  clears = 0;
  scrollTop = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(() => dom.happyDOM.close());

describe('useLineNumberDragSelection', () => {
  test('keeps following the pointer after it drifts off the line numbers', async () => {
    const editor = await render();
    pressLineNumber(editor, 3);
    expect(selection).toEqual({ start: 3, end: 3 });
    expect(drag?.isDragging).toBe(true);

    // Far to the right, over the code, and then outside the editor's width.
    moveTo(300, lineY(editor, 6));
    expect(selection).toEqual({ start: 3, end: 6 });
    moveTo(900, lineY(editor, 9));
    expect(selection).toEqual({ start: 3, end: 9 });
    moveTo(900, lineY(editor, 1));
    expect(selection).toEqual({ start: 1, end: 3 });

    release();
    expect(drag?.isDragging).toBe(false);
    moveTo(300, lineY(editor, 7));
    expect(selection).toEqual({ start: 1, end: 3 });
  });

  test('marks only the click that ends a drag', async () => {
    const editor = await render();
    expect(drag?.isDragReleaseClick()).toBe(false);
    pressLineNumber(editor, 2);
    moveTo(300, lineY(editor, 5));
    release();
    // Read in the same task as the release: the click a drag-release follows
    // lands here, and only here, the marker must stand.
    expect(drag?.isDragReleaseClick()).toBe(true);
    await settleReleaseClick();
    expect(drag?.isDragReleaseClick()).toBe(false);
  });

  test('scrolls while the pointer is held below the editor and extends to the lines it reveals', async () => {
    const editor = await render();
    pressLineNumber(editor, 4);
    moveTo(20, VISIBLE_LINES * editor.defaultLineHeight + 40);
    // Same task as the move: the frames that would grow the range are still
    // queued, so the range shows the pointer's line only.
    expect(selection).toEqual({ start: 4, end: VISIBLE_LINES });

    // The range must cover the lines the scroll reveals after every round, and
    // every round while the pointer is held must advance the scroll — a loop
    // that stopped rescheduling its frame would stall on the second round.
    const revealedEnd = () => Math.floor((scrollTop + VISIBLE_LINES * editor.defaultLineHeight - 1) / editor.defaultLineHeight) + 1;
    const scrollRound = async () => {
      const before = scrollTop;
      await settleScrollTicks(3);
      expect(scrollTop).toBeGreaterThan(before);
      expect(selection).toEqual({ start: 4, end: revealedEnd() });
    };
    await scrollRound();
    await scrollRound();
    // The scroll must still have room, so the stop check below cannot pass by
    // running out of document (the fixture clamps the position at 90 lines).
    expect(scrollTop).toBeLessThan(80 * editor.defaultLineHeight);

    release();
    const stoppedAt = scrollTop;
    await settleScrollTicks(3);
    expect(scrollTop).toBe(stoppedAt);
  });

  test('a click that wobbles on the last visible line neither scrolls nor grows the range', async () => {
    const editor = await render();
    pressLineNumber(editor, VISIBLE_LINES);
    moveTo(21, lineY(editor, VISIBLE_LINES) + 1);
    // Give every queued frame its chance; the wobble must stay a click.
    await settleScrollTicks(3);
    release();
    expect(scrollTop).toBe(0);
    expect(selection).toEqual({ start: VISIBLE_LINES, end: VISIBLE_LINES });
  });

  test('ends the drag when the button is found released without a mouseup', async () => {
    const editor = await render();
    pressLineNumber(editor, 2);
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: lineY(editor, 6), buttons: 0 }));
    });
    expect(drag?.isDragging).toBe(false);
    expect(selection).toEqual({ start: 2, end: 2 });
  });

  test('shift+click extends the selection; a click on the only selected line clears it', async () => {
    const editor = await render({ start: 5, end: 5 });
    pressLineNumber(editor, 9, { shiftKey: true });
    release();
    expect(selection).toEqual({ start: 5, end: 9 });

    pressLineNumber(editor, 7);
    release();
    expect(selection).toEqual({ start: 7, end: 7 });
    pressLineNumber(editor, 7);
    expect(selection).toBeNull();
    expect(clears).toBe(1);
    expect(drag?.isDragging).toBe(false);
  });

  test('keeps the gutter config across renders', async () => {
    const editor = await render();
    const config = drag?.lineNumbersConfig;
    pressLineNumber(editor, 3);
    moveTo(20, lineY(editor, 6));
    release();
    expect(drag?.lineNumbersConfig).toBe(config);
  });
});
