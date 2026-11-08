import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import type { RuntimeAPIs } from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement, Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// After the DOM globals: React DOM decides at load whether it runs in a browser.
const { createRoot } = await import('react-dom/client');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { useUIStore } = await import('@/stores/useUIStore');
const { ProviderLogo } = await import('./ProviderLogo');

const originalFetch = globalThis.fetch;
const requests: string[] = [];
let answer: () => Response = () => new Response(new Blob(['png']), { status: 200, headers: { 'Content-Type': 'image/png' } });
beforeEach(() => {
  // SAFETY: the logo loader only calls fetch(input, init) and reads the Response; `preconnect` is never used.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    // Path and query only: another test file in the same run may leave a runtime base URL configured.
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    return answer();
  }) as typeof fetch;
});

const unavailable = (): never => { throw new Error('not used'); };
const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
  setTheme: unavailable, reloadCustomThemes: unavailable, importTheme: unavailable,
  deleteImportedTheme: unavailable, isSystemPreference: false, setSystemPreference: unavailable,
  themeMode: 'dark', setThemeMode: unavailable, lightThemeId: getDefaultTheme(false).metadata.id,
  darkThemeId: theme.metadata.id, setLightThemePreference: unavailable, setDarkThemePreference: unavailable,
};
const vscodeRuntimeApis: RuntimeAPIs = {
  runtime: { platform: 'vscode', isDesktop: false, isVSCode: true },
  get terminal() { return unavailable(); }, get git() { return unavailable(); },
  get files() { return unavailable(); }, get settings() { return unavailable(); },
  get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;
// Each test uses its own version, so the shared object URL cache never answers for another test.
let version = 1;

const render = async (element: React.ReactElement) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ThemeSystemContext.Provider value={themeContext}>{element}</ThemeSystemContext.Provider>);
  });
  // Let the fetch and blob settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
};

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = undefined;
  globalThis.fetch = originalFetch;
  requests.length = 0;
  version += 1;
  registerRuntimeAPIs(null);
  answer = () => new Response(new Blob(['png']), { status: 200, headers: { 'Content-Type': 'image/png' } });
  useUIStore.setState({ customProviderIcons: {}, customProviderLogos: {} });
});
afterAll(() => {
  browser.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('ProviderLogo precedence', () => {
  test('draws an uploaded logo over a chosen icon, in its own colours', async () => {
    useUIStore.setState({
      customProviderIcons: { acme: 'server' },
      customProviderLogos: { acme: { mime: 'image/png', updatedAt: version } },
    });
    const view = await render(<ProviderLogo providerId="acme" className="size-4" />);

    const image = view.querySelector('img');
    expect(image?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(image?.className).not.toContain('dark:invert');
    expect(view.querySelector('use')).toBeNull();
    expect(requests).toEqual([`/api/provider/acme/logo?v=${version}`]);
  });

  test('asks for an SVG in the theme variant', async () => {
    useUIStore.setState({ customProviderLogos: { 'campus-llm': { mime: 'image/svg+xml', updatedAt: version } } });
    await render(<ProviderLogo providerId="campus-llm" />);

    expect(requests).toEqual([`/api/provider/campus-llm/logo?v=${version}&theme=dark`]);
  });

  test('an SVG arrives as a data: URL, so opening it in its own tab runs nothing on the app origin', async () => {
    answer = () => new Response(new Blob(['<svg/>']), { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    useUIStore.setState({ customProviderLogos: { acme: { mime: 'image/svg+xml', updatedAt: version } } });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  test('falls back to the chosen icon when the browser cannot draw the upload', async () => {
    useUIStore.setState({
      customProviderIcons: { acme: 'server' },
      customProviderLogos: { acme: { mime: 'image/svg+xml', updatedAt: version } },
    });
    const view = await render(<ProviderLogo providerId="acme" />);

    await act(async () => { view.querySelector('img')?.dispatchEvent(new Event('error')); });
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('use')?.getAttribute('href')).toBe('#oc-server');
  });

  test('falls back to the chosen icon when the uploaded logo cannot be read', async () => {
    answer = () => Response.json({ error: 'Provider logo not found' }, { status: 404 });
    useUIStore.setState({
      customProviderIcons: { acme: 'server' },
      customProviderLogos: { acme: { mime: 'image/png', updatedAt: version } },
    });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('use')?.getAttribute('href')).toBe('#oc-server');
  });

  test('ignoreCustomIcon shows the provider\'s own logo without asking for the upload', async () => {
    useUIStore.setState({ customProviderLogos: { anthropic: { mime: 'image/png', updatedAt: version } } });
    const view = await render(<ProviderLogo providerId="anthropic" ignoreCustomIcon />);

    expect(requests).toEqual([]);
    expect(view.querySelector('img')?.className).toContain('dark:invert');
  });

  test('VS Code, which runs no OpenChamber server, draws the chosen icon', async () => {
    registerRuntimeAPIs(vscodeRuntimeApis);
    useUIStore.setState({
      customProviderIcons: { acme: 'cloud' },
      customProviderLogos: { acme: { mime: 'image/png', updatedAt: version } },
    });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(requests).toEqual([]);
    expect(view.querySelector('use')?.getAttribute('href')).toBe('#oc-cloud');
  });
});
