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
const { NoteEditor } = await import('./NoteEditor');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const BODY = '## Release\n- push the **tag**\n- check `changelog`';

const mountEditor = async (onChange: (value: string) => void = () => {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <NoteEditor value={BODY} onChange={onChange} onBlur={() => {}} ariaLabel="Note text" maxLength={3000} />,
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
