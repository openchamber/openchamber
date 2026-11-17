import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
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

// Before the imports: the OpenCode client keeps the fetch it finds at load.
const fetchSpy = spyOn(globalThis, 'fetch');

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ClassificationProvidersPage } = await import('./ClassificationProvidersPage');

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

const sources = ['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'gemini', 'typesafe', 'custom'];

/** Renders the page with Gemini usable or not and returns its text and container. */
const renderPage = async (geminiUsable: boolean) => {
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/routing' && request.method === 'GET') {
      return Response.json({
        available: true,
        autoReady: false,
        jevAvailable: true,
        tokenPresent: false,
        geminiKeyPresent: false,
        jevSource: 'zen-free',
        config: null,
        builtins: [],
        classification: {
          selected: geminiUsable ? 'gemini' : 'zen-promo',
          effective: geminiUsable ? 'gemini' : 'zen-promo',
          sources: sources.map((id) => ({ id, usable: id === 'off' || id === 'zen-promo' || (geminiUsable && id === 'gemini') })),
        },
      });
    }
    if (pathname.startsWith('/api/routing')) throw new Error(`Unexpected request: ${request.method} ${pathname}`);
    // The directory store the page pulls in lists sessions; none matter here.
    if (pathname === '/api/session') return Response.json({ data: [], cursor: { previous: null, next: null } });
    return Response.json({}, { status: 404 });
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><ClassificationProvidersPage titleLeading={null} onOpenProvider={() => {}} /></I18nProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const text = container.textContent ?? '';
  const keyField = container.querySelector('input[aria-label="Gemini API key"]');
  await act(async () => root.unmount());
  container.remove();
  return { text, keyField };
};

const FREE_TIER = 'On Google\'s free tier, Google may use the requests to improve its products.';

test('offers Google Gemini as a source and a field for its own key', async () => {
  const { text, keyField } = await renderPage(true);
  expect(text).toContain('Google Gemini');
  expect(text).toContain('not Jev');
  expect(text).toContain(FREE_TIER);
  expect(keyField).not.toBeNull();
});

// Saving a key selects Gemini, so the free-tier note must show before there is one.
test('shows what Gemini is and the free-tier note before a key is saved', async () => {
  const { text, keyField } = await renderPage(false);
  expect(text).toContain('not Jev');
  expect(text).toContain(FREE_TIER);
  expect(text).toContain('No Gemini key here');
  expect(keyField).not.toBeNull();
});
