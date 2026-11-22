import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  DocumentFragment: browser.DocumentFragment, ShadowRoot: browser.ShadowRoot, NodeFilter: browser.NodeFilter,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
// This component reaches the draft store. Give its startup home discovery a
// deterministic result so unrelated bootstrap work cannot change draft scope.
spyOn(opencodeClient, 'getSystemInfo').mockResolvedValue({ homeDirectory: '/home/test' });
spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home/test');
const { PromptCandidatesDialog } = await import('./PromptCandidatesDialog');
const generateSpy = spyOn(opencodeClient, 'generateText');
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
  generateSpy.mockReset();
});

async function mount(onUse: (texts: string[]) => void) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<I18nProvider><PromptCandidatesDialog open onOpenChange={() => {}} original="Original task" directory="/repo"
    initialModels={[{ providerID: 'p', modelID: 'm1', instanceId: '1' }, { providerID: 'p', modelID: 'm2', instanceId: '2' }]} onUse={onUse} /></I18nProvider>); });
}
async function click(name: string) {
  const element = [...document.querySelectorAll<HTMLElement>('button,[role="checkbox"]')].find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name);
  if (!element) throw new Error(`Missing control ${name}`);
  await act(async () => { element.click(); });
}
async function describePrompts() {
  const field = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!field || !setter) throw new Error('Description field missing');
  await act(async () => { setter.call(field, 'Variations and new prompts'); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

// Oracle: generating cannot execute prompts; only the explicit selected cards
// are added to the existing composer after the user clicks Add selected prompts.
test('reviews candidates from multiple models and admits only the multiselected prompts', async () => {
  const submitted: string[][] = [];
  generateSpy.mockImplementation(async (_prompt, options) => JSON.stringify({ candidates: [{ title: `Candidate ${options?.model?.id}`, text: `Prompt ${options?.model?.id}`, kind: 'variation' }] }));
  await mount((texts) => { submitted.push(texts); });
  await describePrompts();
  await click('Generate candidates');
  expect(generateSpy.mock.calls.length).toBe(2);
  expect(submitted).toEqual([]);
  await click('Add selected prompts (0)');
  expect(submitted).toEqual([]);
  await click('Candidate m1');
  await click('Candidate m2');
  await click('Candidate m1');
  await click('Add selected prompts (1)');
  expect(submitted).toEqual([['Prompt m2']]);
});

test('partial generation failure keeps successful candidates selectable', async () => {
  const submitted: string[][] = [];
  generateSpy.mockImplementation(async (_prompt, options) => {
    if (options?.model?.id === 'm2') throw new Error('generation failed');
    return JSON.stringify({ candidates: [{ title: 'Successful', text: 'Keep this prompt', kind: 'new' }] });
  });
  await mount((texts) => { submitted.push(texts); });
  await describePrompts();
  await click('Generate candidates');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Successful candidates remain available');
  await click('Successful');
  await click('Add selected prompts (1)');
  expect(submitted).toEqual([['Keep this prompt']]);
});
