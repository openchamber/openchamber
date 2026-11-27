import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { z } from 'zod';
import type { routingStateSchema } from '@/lib/routing/routingApi';

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
const requestOf = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
const supportResponse = (pathname: string) => {
  if (pathname === '/api/fs/home') return Response.json({ home: '/example' });
  if (pathname === '/api/session') return Response.json({ data: [], cursor: { previous: null, next: null } });
  if (pathname === '/api/config/settings') return Response.json({});
  return Response.json({}, { status: 404 });
};
const fetchSpy = spyOn(globalThis, 'fetch')
  .mockImplementation(async (input, init) => supportResponse(new URL(requestOf(input, init).url).pathname));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ClassificationProvidersPage } = await import('./ClassificationProvidersPage');

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

const sources = ['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'gemini', 'typesafe', 'custom'];

type RoutingResponse = z.input<typeof routingStateSchema>;
type RoutingFixture = RoutingResponse & { classification: NonNullable<RoutingResponse['classification']> };

const routingState = (geminiUsable = false): RoutingFixture => ({
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

const withPage = async <T,>(
  state: RoutingFixture,
  inspect: (container: HTMLElement) => T | Promise<T>,
  mutate?: (request: Request) => Promise<Response>,
): Promise<T> => {
  fetchSpy.mockImplementation(async (input, init) => {
    const request = requestOf(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/routing' && request.method === 'GET') {
      return Response.json(state);
    }
    if (mutate && pathname.startsWith('/api/routing/classifier')) return mutate(request);
    if (pathname.startsWith('/api/routing')) throw new Error(`Unexpected request: ${request.method} ${pathname}`);
    return supportResponse(pathname);
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<I18nProvider><ClassificationProvidersPage titleLeading={null} onOpenProvider={() => {}} /></I18nProvider>);
    });
    return await inspect(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

const renderPage = (geminiUsable: boolean) => withPage(routingState(geminiUsable), (container) => ({
  text: container.textContent ?? '',
  keyField: container.querySelector('input[aria-label="Gemini API key"]'),
}));

const openaiRow = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[role="radiogroup"] > [role="button"]'))
  .find((row) => row.textContent?.startsWith('OpenAI Decisions'));

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

test('requires server advertisement and hides OpenAI setup in enterprise mode', async () => {
  await withPage(routingState(), (container) => expect(openaiRow(container)).toBeUndefined());

  const state = routingState();
  state.classification.sources.push({ id: 'openai-decisions', usable: false });
  await withPage({ ...state, enterpriseMode: true, openaiDecisionsStatus: 'api_key_required' }, (container) => {
    expect(openaiRow(container)).toBeUndefined();
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
    expect(container.textContent).toContain('enterprise mode');
  });
});

test('distinguishes missing credentials from a failed lookup without adding a key field', async () => {
  const state = routingState();
  const keyFieldCount = await withPage(state, (container) => container.querySelectorAll('input[type="password"]').length);
  state.classification.sources.push({ id: 'openai-decisions', usable: false });
  for (const [status, message] of [
    ['api_key_required', 'A ChatGPT sign-in does not provide an API key.'],
    ['credential_unavailable', 'The server could not read the OpenAI API key.'],
  ] as const) {
    await withPage({ ...state, openaiDecisionsStatus: status }, (container) => {
      const row = openaiRow(container);
      expect(row?.getAttribute('aria-disabled')).toBe('true');
      expect(row?.textContent).toContain(message);
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(keyFieldCount);
    });
  }
});

const runClassifierTest = async (container: HTMLElement) => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Test');
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
  return container.querySelector('[role="status"]')?.textContent;
};

test('saves OpenAI only on selection and names it when it answers the test', async () => {
  const state = routingState();
  state.classification.sources.push({ id: 'openai-decisions', usable: true });
  let saved = false;
  await withPage(state, async (container) => {
    expect(saved).toBe(false);
    expect(openaiRow(container)?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { openaiRow(container)?.click(); });
    expect(saved).toBe(true);
    expect(openaiRow(container)?.getAttribute('aria-pressed')).toBe('true');

    expect(await runClassifierTest(container)).toContain('Works: OpenAI Decisions answered');
  }, async (request) => {
    if (request.method === 'PUT' && new URL(request.url).pathname === '/api/routing/classifier') {
      expect(await request.json()).toEqual({ source: 'openai-decisions' });
      saved = true;
      return Response.json({ ...state, classification: { ...state.classification, selected: 'openai-decisions', effective: 'openai-decisions' } });
    }
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/routing/classifier/test');
    expect(await request.json()).toEqual({});
    return Response.json({ ok: true, source: 'openai-decisions', model: 'example-model', ms: 10 });
  });
});

test('keeps unavailable OpenAI selected while showing the effective fallback', async () => {
  const state = routingState();
  state.classification.selected = 'openai-decisions';
  state.classification.effective = 'typesafe';
  state.tokenPresent = true;
  state.classification.sources = state.classification.sources.map((source) => source.id === 'typesafe' ? { ...source, usable: true } : source);
  state.classification.sources.push({ id: 'openai-decisions', usable: false });
  await withPage(state, async (container) => {
    const row = openaiRow(container);
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('Jev goes through TypeSafe API key');
    expect(await runClassifierTest(container)).toContain('Works: TypeSafe API key answered');
  }, async (request) => {
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/routing/classifier/test');
    return Response.json({ ok: true, source: 'typesafe', model: 'example-model', ms: 10 });
  });
});

test('explains OpenAI test failures without pointing to editable URL or model settings', async () => {
  const state = routingState();
  state.classification.selected = 'openai-decisions';
  state.classification.effective = 'openai-decisions';
  state.classification.sources.push({ id: 'openai-decisions', usable: true });
  const cases = [
    [{ reason: 'unparsable' }, 'OpenAI Decisions returned an unexpected response. Run the test again.'],
    [{ reason: 'timeout' }, 'OpenAI Decisions did not answer in time. Wait a moment and run the test again.'],
    [{ reason: 'http', status: 404 }, 'OpenAI Decisions is unavailable (HTTP 404). Check that your OpenAI API project has access to Decisions.'],
  ] as const;
  for (const [failure, message] of cases) {
    await withPage(state, async (container) => {
      expect(await runClassifierTest(container)).toBe(message);
    }, async () => Response.json({ ok: false, source: 'openai-decisions', ...failure }));
  }
});

test('still points to the System One endpoint when it returns an unexpected answer', async () => {
  const state = routingState();
  state.classification.selected = 'custom';
  state.classification.effective = 'custom';
  await withPage(state, async (container) => {
    expect(await runClassifierTest(container)).toBe(
      'Custom endpoint answered, but not with a Jev answer. Check that the URL and model point to a System One endpoint.',
    );
  }, async () => Response.json({ ok: false, source: 'custom', reason: 'unparsable' }));
});
