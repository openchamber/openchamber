import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { EditorView } = await import('@codemirror/view');
const { CodeMirrorEditor } = await import('./CodeMirrorEditor');

type EditorProps = React.ComponentProps<typeof CodeMirrorEditor>;

let container: HTMLDivElement;
let root: Root;
let view: InstanceType<typeof EditorView> | null;
let reconfigures: number;
// Stable across renders, as a host passes it; it counts reconfigurations.
const extensions = [EditorView.updateListener.of((update) => {
  if (update.transactions.some((transaction) => transaction.reconfigured)) reconfigures += 1;
})];
const lineNumbersConfig = {};

const render = async (props: Partial<EditorProps> = {}) => {
  await act(async () => {
    root.render(
      <CodeMirrorEditor
        value={'one\ntwo\nthree'}
        onChange={() => {}}
        extensions={extensions}
        lineNumbersConfig={lineNumbersConfig}
        onViewReady={(ready) => { view = ready; }}
        {...props}
      />,
    );
  });
};

beforeEach(() => {
  view = null;
  reconfigures = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(() => dom.happyDOM.close());

describe('CodeMirrorEditor detached', () => {
  test('mounts out of the document when detached, with its state', async () => {
    await render({ detached: true });
    expect(view).not.toBeNull();
    expect(view?.dom.isConnected).toBe(false);
    expect(view?.state.doc.toString()).toBe('one\ntwo\nthree');
  });

  test('leaves the document and comes back into its host, the same view', async () => {
    await render();
    const mounted = view;
    expect(mounted?.dom.isConnected).toBe(true);
    await render({ detached: true });
    expect(mounted?.dom.isConnected).toBe(false);
    await render({ detached: false });
    expect(view).toBe(mounted);
    expect(mounted?.dom.isConnected).toBe(true);
    expect(container.contains(mounted?.dom ?? null)).toBe(true);
  });

  test('is destroyed cleanly while detached', async () => {
    await render({ detached: true });
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(container.querySelector('.cm-editor')).toBeNull();
  });
});

describe('CodeMirrorEditor reconfiguration', () => {
  test('a re-render with equal inputs reconfigures nothing', async () => {
    await render({ highlightLines: { start: 1, end: 2 } });
    reconfigures = 0;
    await render({ highlightLines: { start: 1, end: 2 } });
    await render({ highlightLines: { start: 1, end: 2 }, detached: true });
    await render({ highlightLines: { start: 1, end: 2 }, detached: false });
    expect(reconfigures).toBe(0);
  });

  test('a changed input reconfigures its compartment', async () => {
    await render({ highlightLines: { start: 1, end: 2 } });
    reconfigures = 0;
    await render({ highlightLines: { start: 2, end: 3 } });
    expect(reconfigures).toBe(1);
    await render({ highlightLines: { start: 2, end: 3 }, readOnly: true });
    expect(reconfigures).toBe(2);
    expect(view?.state.facet(EditorView.editable)).toBe(false);
  });
});
