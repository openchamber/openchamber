import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const dom = new Window();
// Frames run when a test flushes them, so no test waits on a real timer.
const frames: FrameRequestCallback[] = [];
const requestFrame = (callback: FrameRequestCallback) => frames.push(callback);
const flushFrames = () => {
  for (let round = 0; round < 10 && frames.length > 0; round += 1) {
    for (const callback of frames.splice(0)) callback(0);
  }
};
Object.assign(dom, { requestAnimationFrame: requestFrame, cancelAnimationFrame: () => {} });
Object.assign(globalThis, {
  // CodeMirror's measuring checks `instanceof Window`.
  Window,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  Node: dom.Node,
  Text: dom.Text,
  NodeFilter: dom.NodeFilter,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  InputEvent: dom.InputEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  DOMRect: dom.DOMRect,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
});

// React DOM checks for input events when it loads, so it loads after the DOM above.
const { createRoot } = await import('react-dom/client');
const { EditorSelection: Selection, EditorState: State } = await import('@codemirror/state');
const { OpenCode } = await import('@opencode/client');
const { CodeMirrorEditor } = await import('@/components/ui/CodeMirrorEditor');
const { I18nProvider } = await import('@/lib/i18n');
const { SyncProvider } = await import('@/sync/sync-context');
const { useInputStore } = await import('@/sync/input-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { loadEmojiTable } = await import('@/lib/emoji/shortcodes');
const { readCodeSelectionQuote } = await import('./codeSelectionComments');
const { useCodeSelectionComment } = await import('./useCodeSelectionComment');

const directory = '/repo';
const DOC = ['function greet(name) {', '\tconst a = 1;   ', '  const b = 1;', '}'].join('\n');
const offset = (state: EditorState, line: number, column: number) => state.doc.line(line).from + column;

describe('readCodeSelectionQuote', () => {
  const quoteOf = (selection: EditorSelection) => {
    const state = State.create({ doc: DOC, selection, extensions: State.allowMultipleSelections.of(true) });
    const quote = readCodeSelectionQuote(state);
    return quote && { code: quote.code, startLine: quote.startLine, endLine: quote.endLine };
  };
  const state = State.create({ doc: DOC });

  test('quotes exactly the selected part of a line', () => {
    expect(quoteOf(Selection.single(offset(state, 1, 9), offset(state, 1, 14)))).toEqual({ code: 'greet', startLine: 1, endLine: 1 });
  });

  test('a backward selection over several lines quotes the same text and lines', () => {
    expect(quoteOf(Selection.single(offset(state, 3, 7), offset(state, 1, 15))))
      .toEqual({ code: 'name) {\n\tconst a = 1;   \n  const', startLine: 1, endLine: 3 });
  });

  test('tabs and trailing spaces stay in the quote', () => {
    expect(quoteOf(Selection.single(offset(state, 2, 0), offset(state, 2, 16)))).toEqual({ code: '\tconst a = 1;   ', startLine: 2, endLine: 2 });
  });

  test('a selection that stops at the start of a line ends on the line before', () => {
    expect(quoteOf(Selection.single(offset(state, 2, 0), offset(state, 3, 0)))).toEqual({ code: '\tconst a = 1;   \n', startLine: 2, endLine: 2 });
  });

  test('repeated text is located where it was selected', () => {
    expect(quoteOf(Selection.single(offset(state, 3, 10), offset(state, 3, 14)))).toEqual({ code: '= 1;', startLine: 3, endLine: 3 });
  });

  test('an empty selection and several selections give no quote', () => {
    expect(quoteOf(Selection.single(offset(state, 2, 3)))).toBeNull();
    expect(quoteOf(Selection.create([
      Selection.range(offset(state, 2, 1), offset(state, 2, 6)),
      Selection.range(offset(state, 3, 2), offset(state, 3, 7)),
    ]))).toBeNull();
  });
});

describe('comment on a code selection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let view: EditorView | null;
  type Coords = { left: number; right: number; top: number; bottom: number };
  const onScreenLine: Coords = { left: 10, right: 60, top: 40, bottom: 52 };
  // happy-dom lays nothing out: each test says where positions are drawn.
  type Layout = { box: Coords; coordsAtPos: (pos: number) => Coords; posAtCoords: () => number };
  let layout: Layout;
  const { addDraft } = useInlineCommentDraftStore.getState();
  const sdk = OpenCode.make({ baseUrl: 'http://comments.test', fetch: () => new Promise<Response>(() => undefined) });

  const Host = ({ filePath, scope, value = DOC }: { filePath: string; scope: string; value?: string }) => {
    const { extension, menu } = useCodeSelectionComment({ filePath, scope });
    const extensions = React.useMemo(() => [State.allowMultipleSelections.of(true), extension], [extension]);
    return (
      <>
        <CodeMirrorEditor
          value={value}
          onChange={() => {}}
          extensions={extensions}
          onViewReady={(ready) => {
            Object.defineProperty(ready, 'coordsAtPos', {
              value: (pos: number) => {
                // CodeMirror throws for a position past the end of its document.
                if (pos > ready.state.doc.length) throw new RangeError(`No position ${pos}`);
                return layout.coordsAtPos(pos);
              },
            });
            Object.defineProperty(ready, 'posAtCoords', { value: () => layout.posAtCoords() });
            Object.defineProperty(ready.scrollDOM, 'getBoundingClientRect', { value: () => ({ ...layout.box, width: layout.box.right - layout.box.left, height: layout.box.bottom - layout.box.top }) });
            view = ready;
          }}
        />
        {menu}
      </>
    );
  };

  const render = async (props: { filePath: string; scope: string; value?: string } = { filePath: 'src/a.ts', scope: 'docked' }) => {
    await act(async () => root.render(
      <I18nProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <Host {...props} />
        </SyncProvider>
      </I18nProvider>,
    ));
    if (!view) throw new Error('editor did not mount');
    return view;
  };

  const settle = () => act(async () => flushFrames());

  const select = async (editor: EditorView, selection: EditorSelection, { focus = true } = {}) => {
    if (focus) editor.focus();
    editor.dispatch({ selection });
    await settle();
  };

  const commentButton = () => [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Comment') ?? null;
  const drafts = () => useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'ses_1' });

  const write = async (text: string) => {
    const field = document.body.querySelector('textarea');
    if (!field) throw new Error('no comment field');
    await act(async () => {
      // React tracks the field's value; set it the way the browser's input does.
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    return field;
  };

  const writeAndAttach = async (text: string) => {
    const field = await write(text);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
  };

  beforeEach(() => {
    frames.length = 0;
    view = null;
    layout = { box: { left: 0, right: 400, top: 0, bottom: 300 }, coordsAtPos: () => onScreenLine, posAtCoords: () => 0 };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useProjectsStore.setState({ projects: [{ id: 'repo', path: directory }] });
    useSessionUIStore.setState({ currentSessionId: 'ses_1', currentSessionDirectory: directory });
    useInputStore.setState({ composerAddress: { inline: { directory, sessionKey: 'ses_1' }, attachments: null } });
    useInlineCommentDraftStore.setState({ drafts: {} });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    useInlineCommentDraftStore.setState({ drafts: {}, addDraft });
    useInputStore.setState({ composerAddress: null });
  });

  test('attaches the selected text of the open document with its lines, without sending', async () => {
    const editor = await render();
    // An unsaved edit: the quote comes from what the editor shows.
    editor.dispatch({ changes: { from: 0, insert: 'export ' } });
    await select(editor, Selection.single(offset(editor.state, 1, 16), offset(editor.state, 2, 7)));
    const button = commentButton();
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    await writeAndAttach('why two?');

    expect(drafts().map(({ source, fileLabel, startLine, endLine, code, text }) => ({ source, fileLabel, startLine, endLine, code, text }))).toEqual([
      { source: 'file-quote', fileLabel: 'src/a.ts', startLine: 1, endLine: 2, code: 'greet(name) {\n\tconst ', text: 'why two?' },
    ]);
    expect(document.body.querySelector('textarea')).toBeNull();
    expect(commentButton()).toBeNull();
  });

  test('a refused save keeps the field and its text', async () => {
    const editor = await render();
    await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)));
    await act(async () => commentButton()?.click());
    useInlineCommentDraftStore.setState({ addDraft: () => null });
    await writeAndAttach('keep me');

    expect(document.body.querySelector('textarea')?.value).toBe('keep me');
  });

  test('several selections, an unfocused editor and a new scope show no Comment', async () => {
    const editor = await render();
    await select(editor, Selection.create([
      Selection.range(offset(editor.state, 2, 1), offset(editor.state, 2, 6)),
      Selection.range(offset(editor.state, 3, 2), offset(editor.state, 3, 7)),
    ]));
    expect(commentButton()).toBeNull();

    editor.contentDOM.blur();
    await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)), { focus: false });
    expect(commentButton()).toBeNull();

    await select(editor, Selection.single(offset(editor.state, 1, 0), offset(editor.state, 1, 5)));
    expect(commentButton()).not.toBeNull();
    await render({ filePath: 'src/a.ts', scope: 'hidden' });
    expect(commentButton()).toBeNull();
  });

  const popup = () => document.body.querySelector('textarea')?.closest<HTMLElement>('.fixed') ?? null;
  const at = (top: number): Coords => ({ ...onScreenLine, top, bottom: top + 12 });

  test('Select All with both ends off screen offers Comment and quotes the whole selection', async () => {
    const editor = await render();
    const firstShown = offset(editor.state, 2, 0);
    const lastShown = editor.state.doc.line(3).to;
    layout.coordsAtPos = (pos) => (pos < firstShown ? at(-40) : pos > lastShown ? at(340) : onScreenLine);
    layout.posAtCoords = () => firstShown;
    await select(editor, Selection.single(0, editor.state.doc.length));
    await act(async () => commentButton()?.click());
    await writeAndAttach('all of it');

    expect(drafts().map(({ startLine, endLine, code }) => ({ startLine, endLine, code }))).toEqual([{ startLine: 1, endLine: 4, code: DOC }]);
  });

  test('the comment field stays inside the window when the selection is at its edge', async () => {
    const editor = await render();
    layout.box = { left: 0, right: window.innerWidth, top: 0, bottom: 300 };
    layout.coordsAtPos = () => ({ left: window.innerWidth - 20, right: window.innerWidth - 10, top: 40, bottom: 52 });
    const field = { width: 420, height: 160 };
    const measureElement = HTMLElement.prototype.getBoundingClientRect;
    // The field is the popup's child that holds the textarea; happy-dom gives it no size.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.parentElement?.classList.contains('fixed') && this.querySelector('textarea')
        ? new DOMRect(0, 0, field.width, field.height)
        : measureElement.call(this);
    };
    try {
      await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)));
      await act(async () => commentButton()?.click());
      await settle();

      const shown = popup();
      expect(shown?.style.transform).toBe('');
      const left = Number.parseFloat(shown?.style.left ?? '');
      const top = Number.parseFloat(shown?.style.top ?? '');
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + field.width).toBeLessThanOrEqual(window.innerWidth);
      expect(top).toBeGreaterThanOrEqual(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measureElement;
    }
  });

  test('an open comment follows its text when the file gets shorter, and keeps what was written', async () => {
    const editor = await render();
    await select(editor, Selection.single(offset(editor.state, 3, 0), editor.state.doc.length));
    await act(async () => commentButton()?.click());
    await write('still here');
    await settle();
    expect(popup()?.style.top).toBe('32px');

    // An agent removes the first line while the field is open, then the editor scrolls.
    editor.dispatch({ changes: { from: 0, to: offset(editor.state, 2, 0) } });
    layout.coordsAtPos = () => at(140);
    await act(async () => editor.scrollDOM.dispatchEvent(new Event('scroll')));
    await settle();

    expect(popup()?.style.top).toBe('132px');
    expect(document.body.querySelector('textarea')?.value).toBe('still here');
    await writeAndAttach('still here');
    expect(drafts().map(({ startLine, endLine, code }) => ({ startLine, endLine, code }))).toEqual([{ startLine: 3, endLine: 4, code: '  const b = 1;\n}' }]);
  });

  const press = (target: Element) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });

  test('a refresh from disk moves the open field to where its text now is', async () => {
    const editor = await render();
    await select(editor, Selection.single(offset(editor.state, 3, 0), editor.state.doc.length));
    await act(async () => commentButton()?.click());
    await write('still here');
    await settle();
    expect(popup()?.style.top).toBe('32px');

    // Files refreshes the editor's value: the first line is gone, the quoted lines move up one.
    const refreshed = DOC.slice(DOC.indexOf('\n') + 1);
    layout.coordsAtPos = (pos) => (pos === refreshed.indexOf('  const b') ? at(140) : at(500));
    await render({ filePath: 'src/a.ts', scope: 'docked', value: refreshed });
    await settle();
    expect(popup()?.style.top).toBe('132px');

    // A refresh that removes the quoted text keeps the field, its text and its last place.
    await render({ filePath: 'src/a.ts', scope: 'docked', value: 'function greet(name) {\n' });
    await settle();
    expect(popup()?.style.top).toBe('132px');
    await writeAndAttach('still here');
    expect(drafts().map(({ startLine, endLine, code, text }) => ({ startLine, endLine, code, text })))
      .toEqual([{ startLine: 3, endLine: 4, code: '  const b = 1;\n}', text: 'still here' }]);
  });

  test('choosing a suggestion in the comment field keeps the field and inserts it', async () => {
    await loadEmojiTable();
    const editor = await render();
    await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)));
    await act(async () => commentButton()?.click());
    await write('nice :smile');
    await settle();
    const option = [...document.body.querySelectorAll<HTMLElement>('.oc-inline-picker .cursor-pointer')].find((entry) => entry.textContent === '😄:smile:');
    if (!option) throw new Error('no suggestion shown');
    await press(option);
    await act(async () => option.click());

    const field = document.body.querySelector('textarea');
    expect(field).not.toBeNull();
    expect(field?.value).toBe('nice 😄 ');
  });

  test('pressing the editor scrollbar keeps the comment field, a press outside closes it', async () => {
    const editor = await render();
    await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)));
    await act(async () => commentButton()?.click());
    await write('keep me');
    const thumb = document.body.querySelector('.overlay-scrollbar [data-overlay-scrollbar-thumb]');
    if (!thumb) throw new Error('no editor scrollbar');
    await press(thumb);
    expect(document.body.querySelector('textarea')?.value).toBe('keep me');

    await press(document.body);
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  test('a narrowed window places the open field inside it again', async () => {
    const editor = await render();
    const width = window.innerWidth;
    layout.box = { left: 0, right: width, top: 0, bottom: 300 };
    layout.coordsAtPos = () => ({ left: width - 70, right: width - 60, top: 40, bottom: 52 });
    const measureElement = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.parentElement?.classList.contains('fixed') && this.querySelector('textarea')
        ? new DOMRect(0, 0, 420, 160)
        : measureElement.call(this);
    };
    try {
      await select(editor, Selection.single(offset(editor.state, 1, 9), offset(editor.state, 1, 14)));
      await act(async () => commentButton()?.click());
      await settle();
      const narrowed = width - 300;
      await act(async () => {
        dom.happyDOM.setViewport({ width: narrowed, height: window.innerHeight });
        window.dispatchEvent(new Event('resize'));
      });
      expect(Number.parseFloat(popup()?.style.left ?? '') + 420).toBeLessThanOrEqual(narrowed);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measureElement;
    }
  });
});

afterAll(() => dom.happyDOM.close());
