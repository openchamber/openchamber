import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event,
  FocusEvent: browser.FocusEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// React's input-event support is detected when react-dom loads.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { BehaviorPage } = await import('./BehaviorPage');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
const fetchSpy = spyOn(globalThis, 'fetch');

afterEach(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('a slow prompt save preserves and then persists the newer blurred draft', async () => {
  const writes: Array<{ content: string; expectedContent: string | null; finish: () => void }> = [];
  const settingsWrites: Array<() => void> = [];
  let persisted = 'initial';
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/behavior/agents-md') {
      if (request.method === 'GET') {
        return Response.json({ content: persisted, exists: true, path: '/test/AGENTS.md' });
      }
      const body: { content: string; expectedContent: string | null } = await request.json();
      return new Promise<Response>((resolve) => {
        writes.push({ content: body.content, expectedContent: body.expectedContent, finish: () => {
          persisted = body.content;
          resolve(Response.json({ success: true }));
        } });
      });
    }
    if (pathname === '/api/config/settings') {
      if (request.method === 'GET') return Response.json({});
      const body = await request.text();
      return new Promise<Response>((resolve) => {
        settingsWrites.push(() => resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } })));
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${pathname}`);
  });

  const settle = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await act(async () => { root.render(<I18nProvider><BehaviorPage /></I18nProvider>); });
  await settle();
  const prompt = container.querySelector<HTMLTextAreaElement>('textarea[rows="12"]');
  if (!prompt) throw new Error('Missing system prompt field');
  expect(prompt.disabled).toBe(false);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing native textarea setter');
  const edit = async (value: string) => {
    await act(async () => {
      setValue.call(prompt, value);
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { prompt.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await settle();
  };

  await edit('older');
  await edit('newer');
  expect(writes.map((write) => write.content)).toEqual(['older\n']);
  await act(async () => { writes[0].finish(); });
  expect(prompt.value).toBe('newer');

  // The shared settings mirror is debounced separately from the AGENTS.md PUT.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(settingsWrites).toHaveLength(1);
  await act(async () => { settingsWrites[0](); });
  await settle();
  expect(writes.map((write) => write.content)).toEqual(['older\n', 'newer\n']);
  // Each write names the file it replaces, so an edit made elsewhere is refused.
  expect(writes.map((write) => write.expectedContent)).toEqual(['initial', 'older\n']);
  await act(async () => { writes[1].finish(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(settingsWrites).toHaveLength(2);
  await act(async () => { settingsWrites[1](); });
  expect(prompt.value).toBe('newer\n');
  expect(persisted).toBe('newer\n');

  // An edit made in another editor shows up when the window is focused again.
  persisted = 'edited elsewhere\n';
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await settle();
  expect(prompt.value).toBe('edited elsewhere\n');
});
