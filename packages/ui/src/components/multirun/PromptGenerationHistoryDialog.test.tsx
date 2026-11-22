import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, DocumentFragment: browser.DocumentFragment, ShadowRoot: browser.ShadowRoot,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent, PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home/test');
spyOn(opencodeClient, 'getSystemInfo').mockResolvedValue({ homeDirectory: '/home/test' });
spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
const { PromptGenerationHistoryDialog } = await import('./PromptGenerationHistoryDialog');
const history = spyOn(opencodeClient, 'getSessionMessages');
const inbox = spyOn(opencodeClient, 'getSessionInbox');
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ''; history.mockReset(); inbox.mockReset(); });

// Oracle: archived records are read from their real domain shapes without
// resuming a turn. Closed history mounts no reading body; source choice changes
// only the shown records and never membership or files.
test('closed history performs no reads; opening shows archived inbox records for the selected model', async () => {
  history.mockResolvedValue({ items: [], cursor: {} });
  inbox.mockImplementation(async (id) => ['request', 'result'].map((kind) => ({
    info: { id: `${id}-${kind}`, sessionID: id, role: 'synthetic', time: { created: 1 }, text: `${id} ${kind}`, metadata: { openchamberPromptGeneration: { kind } } }, parts: null,
  })));
  const sources = ['a', 'b'].map((id) => ({ sessionID: id, directory: '/repo', providerID: 'p', modelID: id }));
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = (open: boolean) => act(async () => root?.render(<I18nProvider><PromptGenerationHistoryDialog open={open} onOpenChange={() => {}} sources={sources} /></I18nProvider>));
  await render(false);
  expect(history.mock.calls).toHaveLength(0);
  await render(true);
  expect([...document.querySelectorAll('textarea')].map((field) => field.value)).toEqual(['a request', 'a result']);
  const reads = history.mock.calls.length;
  await act(async () => root?.render(<I18nProvider><PromptGenerationHistoryDialog open onOpenChange={() => {}} sources={sources.map((source) => ({ ...source }))} /></I18nProvider>));
  expect(history.mock.calls.length).toBe(reads);
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((field) => field.textContent === 'p/b');
  if (!button) throw new Error('Missing generation source control');
  await act(async () => button.click());
  expect([...document.querySelectorAll('textarea')].map((field) => field.value)).toEqual(['b request', 'b result']);
  expect(inbox.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
});
