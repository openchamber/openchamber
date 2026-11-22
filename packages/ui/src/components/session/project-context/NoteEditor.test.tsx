import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Text: browser.Text,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
// Deterministic partial-tree simulation for the #627 regression test below.
// The background parser publishes its tree in stages; syntaxTree() can hand
// back a tree that only covers a prefix of the document. Stubbing that stage
// in (instead of relying on CPU contention to cut the first parse short, the
// way #534 originally flaked) makes the partial tree exact and repeatable:
// while `partialCut` is set, the exported syntaxTree() returns a tree parsed
// from the document prefix only. ensureSyntaxTree stays the real function,
// so a decoration pass that finishes the parse itself still sees everything.
const language = await import('@codemirror/language');
const { markdownLanguage } = await import('@codemirror/lang-markdown');
const { mock } = await import('bun:test');
let partialCut: number | null = null;
const realSyntaxTree = language.syntaxTree;
mock.module('@codemirror/language', () => ({
  ...language,
  syntaxTree: (state: Parameters<typeof realSyntaxTree>[0]) => {
    if (partialCut === null) return realSyntaxTree(state);
    return markdownLanguage.parser.parse(state.doc.sliceString(0, partialCut));
  },
}));

const { NoteEditor } = await import('./NoteEditor');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const BODY = '## Release\n- push the **tag**\n- check `changelog`';

const mountEditor = async (onChange: (value: string) => void = () => {}, body: string = BODY) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <NoteEditor value={body} onChange={onChange} onBlur={() => {}} ariaLabel="Note text" maxLength={3000} />,
  ));
  const editorNode = host.querySelector<HTMLElement>('.cm-editor');
  const view = editorNode ? EditorView.findFromDOM(editorNode) : null;
  if (!view) throw new Error('Editor missing');
  return { view, content: () => view.contentDOM.textContent ?? '' };
};

test('reads as formatted text: markers are hidden and list items get bullets', async () => {
  const { content } = await mountEditor();
  expect(content()).not.toContain('##');
  expect(content()).not.toContain('**');
  expect(content()).not.toContain('`');
  expect(content()).toContain('•');
  expect(content()).toContain('Release');
});

test('the line being edited shows its markers; the stored text is untouched Markdown', async () => {
  let saved = '';
  const { view, content } = await mountEditor((value) => { saved = value; });
  await act(async () => {
    view.focus();
    view.dispatch({ selection: { anchor: BODY.indexOf('tag') } });
  });
  expect(content()).toContain('**tag**');
  expect(content()).not.toContain('##');

  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n- announce' } }));
  expect(saved).toBe(`${BODY}\n- announce`);
});


// Regression test for #534 / PR #553 (issue #627): on first render the
// background parser may only have published a partial syntax tree. The
// decoration pass must finish the parse itself; decorating from the partial
// tree leaves the markers of every line past the cut visible. The cut below
// lands after the fifth list item, well inside the rendered viewport, so the
// items after it are the ones that used to render raw.
const PARTIAL_BODY = [
  '## Release checklist',
  ...Array.from({ length: 20 }, (_, i) => `- routine item ${i} with **bold** text and \`code\` span`),
].join('\n');

test('first render is formatted past a partial syntax tree (partial-tree regression)', async () => {
  const cut = PARTIAL_BODY.indexOf('- routine item 5');
  expect(cut).toBeGreaterThan(0);
  partialCut = cut;
  try {
    const { content } = await mountEditor(() => {}, PARTIAL_BODY);
    expect(content()).not.toContain('##');
    expect(content()).not.toContain('**');
    expect(content()).not.toContain('`');
    expect(content()).not.toContain('- routine item');
    expect(content()).toContain('routine item 10');
    expect(content()).toContain('•');
  } finally {
    partialCut = null;
  }
});
