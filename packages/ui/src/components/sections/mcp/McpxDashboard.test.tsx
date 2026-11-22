import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

// Clamp every AbortSignal.timeout deadline to 25ms, the runtime-auth
// test pattern, so a stalled fetch reaches its deadline inside the test.
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = (delay: number) => originalTimeout(Math.min(delay, 25));

type FetchHandler = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
let fetchHandler: FetchHandler = async () => Response.json({});
const fetchCalls: Array<{ url: string; signal?: AbortSignal }> = [];
// SAFETY: the stub narrows fetch to the (input, init) shape these tests
// drive; every call still returns a real Response, and the component
// only ever passes (url, { signal }).
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((input: string | URL, init?: { signal?: AbortSignal }) => {
  const url = String(input);
  fetchCalls.push({ url, signal: init?.signal });
  return fetchHandler(url, init);
}) as typeof fetch);
void fetchSpy;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { McpxDashboard } = await import('./McpxDashboard');
let container = document.createElement('div');
let root = createRoot(container);

const renderDashboard = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<McpxDashboard />); });
};

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchCalls.length = 0;
});

const refreshButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.includes('Refresh'));

test('a stalled status load reaches the error state by deadline and Refresh is usable again', async () => {
  fetchHandler = (url: string, init?: { signal?: AbortSignal }) => {
    if (url === '/api/mcpx/status') {
      // Never settles on its own; only the caller's deadline ends it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return Promise.resolve(Response.json([]));
  };

  await renderDashboard();
  expect(refreshButton()?.disabled).toBe(true);

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 75)); });

  const statusCall = fetchCalls.find((call) => call.url === '/api/mcpx/status');
  expect(statusCall?.signal).toBeInstanceOf(AbortSignal);
  expect(container.querySelector('.text-destructive')).not.toBeNull();
  expect(refreshButton()?.disabled).toBe(false);
});

test('a late types response for a superseded namespace never overwrites the current one', async () => {
  const pending = new Map<string, (response: Response) => void>();
  fetchHandler = (url: string) => {
    if (url === '/api/mcpx/status') return Promise.resolve(Response.json({ daemon: { running: true, pid: 1 } }));
    if (url === '/api/mcpx/namespaces') {
      return Promise.resolve(Response.json([{ namespace: 'alpha' }, { namespace: 'beta' }]));
    }
    if (url.startsWith('/api/mcpx/types')) {
      const ns = new URLSearchParams(url.split('?')[1]).get('namespace') ?? '';
      return new Promise<Response>((resolve) => { pending.set(ns, resolve); });
    }
    return Promise.resolve(Response.json({}));
  };

  await renderDashboard();
  // Each namespace card is itself a button whose click opens its types.
  const cardButton = (ns: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent?.includes(ns) && entry.textContent?.includes('tools'));
  const alphaCard = cardButton('alpha');
  const betaCard = cardButton('beta');
  if (!alphaCard || !betaCard) throw new Error('Missing namespace cards');

  await act(async () => { alphaCard.click(); });
  await act(async () => { betaCard.click(); });
  expect(container.textContent).toContain('TypeScript Signatures: beta');

  // The current selection answers first and is applied.
  await act(async () => { pending.get('beta')?.(Response.json({ types: 'BETA_TYPES' })); });
  expect(container.textContent).toContain('BETA_TYPES');

  // The superseded request answers late and must be dropped.
  await act(async () => { pending.get('alpha')?.(Response.json({ types: 'ALPHA_TYPES' })); });
  expect(container.textContent).toContain('BETA_TYPES');
  expect(container.textContent).not.toContain('ALPHA_TYPES');

  const typesCalls = fetchCalls.filter((call) => call.url.startsWith('/api/mcpx/types'));
  expect(typesCalls.length).toBe(2);
  expect(typesCalls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
});
