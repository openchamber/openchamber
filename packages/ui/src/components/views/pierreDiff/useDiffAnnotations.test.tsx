import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, Node: browser.Node, Element: browser.Element,
  HTMLElement: browser.HTMLElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, Event: browser.Event, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAnnotationRenderer } = await import('./useDiffAnnotations');
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('a comment field that cannot take focus yet gets it back on a later render', async () => {
  let annotations!: ReturnType<typeof useAnnotationRenderer>;
  const diff = { current: container };
  const expand = { current: () => {} };
  const Probe = () => {
    annotations = useAnnotationRenderer({ diffContainerRef: diff, requestTrailingExpansionRef: expand, showLinesBelowLabel: '' });
    return <textarea />;
  };
  await act(async () => root.render(<Probe />));
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Missing field');
  const focus = field.focus.bind(field);
  field.focus();
  annotations.holdTypingField();
  field.blur();

  field.focus = () => {};
  annotations.returnTypingField();
  expect(document.activeElement).toBe(document.body);
  field.focus = focus;
  annotations.returnTypingField();
  expect(document.activeElement).toBe(field);

  field.blur();
  annotations.returnTypingField();
  expect(document.activeElement).toBe(document.body);

  field.focus();
  annotations.holdTypingField();
  field.blur();
  document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
  annotations.returnTypingField();
  expect(document.activeElement).toBe(document.body);
});
