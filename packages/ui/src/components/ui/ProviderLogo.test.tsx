import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { plugin } from 'bun';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { InstalledGuest } from '@/lib/guests/types';

// Expand Vite's eager asset glob for Bun, so the bundled logos are there as in the app.
plugin({
  name: 'provider-logo-assets',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const folder = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
        .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
      const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
      return { contents, loader: 'ts' };
    });
  },
});

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
const { useGuestsStore } = await import('@/lib/guests/store');
const { preloadProviderLogos } = await import('@/hooks/useProviderLogo');
const { ProviderLogo } = await import('./ProviderLogo');

const originalFetch = globalThis.fetch;
const requests: string[] = [];
let answer: () => Response | Promise<Response> = () => new Response(new Blob(['png']), { status: 200, headers: { 'Content-Type': 'image/png' } });
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
  useGuestsStore.setState({ guests: [] });
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

describe('ProviderLogo with an extension\'s logo', () => {
  const MODELS_DEV_ACME = 'https://models.dev/logos/acme.svg';
  const installLogos = (providerLogos: Record<string, string>, overrides: Partial<InstalledGuest> = {}) => {
    useGuestsStore.setState({ guests: [{
      id: 'logos', name: 'Logos', icon: 'window', capabilities: { requested: [], granted: [] }, source: 'path', version: String(version), providerLogos, ...overrides,
    }] });
  };

  test('takes the place of the models.dev logo, in its own colours', async () => {
    installLogos({ acme: 'art/acme.png' });
    const view = await render(<ProviderLogo providerId="acme" className="size-4" />);

    const image = view.querySelector('img');
    expect(image?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(image?.className).not.toContain('dark:invert');
    expect(requests).toEqual([`/api/guests/logos/art/acme.png?v=${version}.0`]);
  });

  test('asks for an SVG in the theme variant', async () => {
    installLogos({ acme: 'acme.svg' });
    await render(<ProviderLogo providerId="acme" />);

    expect(requests).toEqual([`/api/guests/logos/acme.svg?v=${version}.0&theme=dark`]);
  });

  test('an SVG from a package arrives as a data: URL too', async () => {
    answer = () => new Response(new Blob(['<svg/>']), { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    installLogos({ acme: 'acme.svg' });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  test('so does anything else that is not a raster image', async () => {
    answer = () => new Response(new Blob(['<script></script>']), { status: 200, headers: { 'Content-Type': 'text/html' } });
    installLogos({ acme: 'acme.png' });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('data:text/html')).toBe(true);
  });

  test('holds its place while the logo loads, without showing the models.dev one', async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    answer = () => pending;
    installLogos({ acme: 'acme.png' });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('span[aria-hidden]')).not.toBeNull();
    await act(async () => {
      finish(new Response(new Blob(['png']), { status: 200, headers: { 'Content-Type': 'image/png' } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
  });

  test('replaces a bundled logo, in its own colours', async () => {
    installLogos({ anthropic: 'own.png' });
    const view = await render(<ProviderLogo providerId="anthropic" />);

    const image = view.querySelector('img');
    expect(image?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(image?.className).not.toContain('dark:invert');
    expect(requests).toEqual([`/api/guests/logos/own.png?v=${version}.0`]);
  });

  test('the bundled logo comes back when the package file cannot be read', async () => {
    answer = () => new Response(null, { status: 404 });
    installLogos({ anthropic: 'own.png' });
    const view = await render(<ProviderLogo providerId="anthropic" />);

    expect(view.querySelector('img')?.getAttribute('src')).toContain('provider-logos/anthropic.svg');
  });

  test('an ID the app draws with that bundled logo follows it, as the usage card does', async () => {
    installLogos({ anthropic: 'own.png' });
    const view = await render(<ProviderLogo providerId="claude" />);

    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(requests).toEqual([`/api/guests/logos/own.png?v=${version}.0`]);
  });

  test('a logo named for the ID itself beats one named for what it aliases to', async () => {
    installLogos({ anthropic: 'own.png', claude: 'exact.png' });
    await render(<ProviderLogo providerId="claude" />);

    expect(requests).toEqual([`/api/guests/logos/exact.png?v=${version}.0`]);
  });

  test('the bundled logo stays on screen until the replacement arrives, when the catalog lands after it', async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    answer = () => pending;
    const view = await render(<ProviderLogo providerId="anthropic" />);
    expect(view.querySelector('img')?.getAttribute('src')).toContain('provider-logos/anthropic.svg');

    await act(async () => { installLogos({ anthropic: 'own.png' }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.querySelector('img')?.getAttribute('src')).toContain('provider-logos/anthropic.svg');

    await act(async () => {
      finish(new Response(new Blob(['png']), { status: 200, headers: { 'Content-Type': 'image/png' } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
  });

  test('a paused extension draws nothing', async () => {
    installLogos({ acme: 'acme.png' }, { enabled: false });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')).toBe(MODELS_DEV_ACME);
    expect(requests).toEqual([]);
  });

  test('neither does one still waiting for approval', async () => {
    installLogos({ acme: 'acme.png' }, { capabilities: { requested: ['prompt'], granted: [] } });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')).toBe(MODELS_DEV_ACME);
    expect(requests).toEqual([]);
  });

  test('an upload outranks it, and it is not even fetched', async () => {
    installLogos({ acme: 'acme.png' });
    useUIStore.setState({ customProviderLogos: { acme: { mime: 'image/png', updatedAt: version } } });
    await render(<ProviderLogo providerId="acme" />);

    expect(requests).toEqual([`/api/provider/acme/logo?v=${version}`]);
  });

  test('so does a chosen icon', async () => {
    installLogos({ acme: 'acme.png' });
    useUIStore.setState({ customProviderIcons: { acme: 'cloud' } });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('use')?.getAttribute('href')).toBe('#oc-cloud');
    expect(requests).toEqual([]);
  });

  test('pausing the extension gives the provider its previous logo back', async () => {
    installLogos({ acme: 'acme.png' });
    const view = await render(<ProviderLogo providerId="acme" />);
    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);

    await act(async () => { installLogos({ acme: 'acme.png' }, { enabled: false }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.querySelector('img')?.getAttribute('src')).toBe(MODELS_DEV_ACME);
  });

  test('ignoreCustomIcon still shows it: it is the provider\'s own logo', async () => {
    installLogos({ acme: 'acme.png' });
    useUIStore.setState({ customProviderIcons: { acme: 'cloud' } });
    const view = await render(<ProviderLogo providerId="acme" ignoreCustomIcon />);

    expect(view.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
  });

  test('falls through to models.dev when the package file cannot be read', async () => {
    answer = () => new Response(null, { status: 404 });
    installLogos({ acme: 'acme.png' });
    const view = await render(<ProviderLogo providerId="acme" />);

    expect(view.querySelector('img')?.getAttribute('src')).toBe(MODELS_DEV_ACME);
  });

  test('an upload and an extension logo that both fail to draw settle on models.dev', async () => {
    installLogos({ acme: 'acme.svg' });
    useUIStore.setState({ customProviderLogos: { acme: { mime: 'image/svg+xml', updatedAt: version } } });
    const view = await render(<ProviderLogo providerId="acme" />);
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const upload = view.querySelector('img');
    await act(async () => { upload?.dispatchEvent(new Event('error')); });
    await settle();
    const fromExtension = view.querySelector('img');
    expect(fromExtension?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(fromExtension?.getAttribute('src')).not.toBe(upload?.getAttribute('src'));

    await act(async () => { fromExtension?.dispatchEvent(new Event('error')); });
    await settle();
    expect(view.querySelector('img')?.getAttribute('src')).toBe(MODELS_DEV_ACME);
  });

  test('a logo it replaces is not preloaded, bundled or from models.dev', () => {
    const preloaded: string[] = [];
    class RecordingImage {
      set src(value: string) { preloaded.push(value); }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: RecordingImage });
    installLogos({ 'logo-only-provider': 'a.png', google: 'b.png' });
    preloadProviderLogos(['logo-only-provider', 'google', 'anthropic']);
    Reflect.deleteProperty(globalThis, 'Image');

    expect(preloaded).toHaveLength(1);
    expect(preloaded[0]).toContain('provider-logos/anthropic.svg');
  });
});
