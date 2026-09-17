import { describe, expect, test } from 'bun:test';

import {
  annotationTargetCount,
  isBrowserAnnotationPayload,
  isBrowserElementTarget,
  isBrowserTarget,
  navStatusUrl,
  type BrowserAnnotationPayload,
  type BrowserElementTarget,
  type BrowserSession,
  type BrowserTabInfo,
  type BrowserTarget,
} from './contract';
import {
  createElectronWebviewBackend,
  type ElectronWebviewBackendDeps,
} from './electronWebviewBackend';

const element: BrowserElementTarget = {
  tag: 'button',
  text: 'Save',
  selector: '#save',
  path: 'main > form > button#save',
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  center: { x: 60, y: 40 },
  attributes: { id: 'save' },
  computedStyle: { display: 'flex' },
  ancestry: [{ tag: 'form', selectorPart: 'form' }],
};

const payload: BrowserAnnotationPayload = {
  id: 'annotation-1',
  pageUrl: 'http://localhost:5173/settings',
  pageTitle: 'Settings',
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 2,
  comment: 'Make this primary',
  elements: [{ id: 'element-1', element }],
  regions: [{ id: 'region-1', rect: { x: 200, y: 0, width: 50, height: 50 } }],
  strokes: [],
};

describe('navigation status', () => {
  test('idle carries no url; the other states carry the one they describe', () => {
    expect(navStatusUrl({ kind: 'idle' })).toBe('');
    expect(navStatusUrl({ kind: 'loading', url: 'http://a/' })).toBe('http://a/');
    expect(navStatusUrl({ kind: 'ready', url: 'http://a/', title: 'A' })).toBe('http://a/');
    expect(navStatusUrl({ kind: 'failed', url: 'http://a/', code: -6, description: 'FILE_NOT_FOUND' }))
      .toBe('http://a/');
  });
});

describe('element target validation', () => {
  test('accepts a fully-formed target', () => {
    expect(isBrowserElementTarget(element)).toBe(true);
  });

  test('rejects payloads that would only fail later, at prompt or draw time', () => {
    expect(isBrowserElementTarget({ ...element, attributes: { id: 3 } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, computedStyle: { display: null } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, ancestry: [{ tag: 'form' }] })).toBe(false);
    expect(isBrowserElementTarget({ ...element, center: { x: 1 } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, bounds: { x: 1, y: 2, width: 3 } })).toBe(false);
  });

  test('rejects non-finite geometry rather than passing NaN downstream', () => {
    expect(isBrowserElementTarget({ ...element, bounds: { x: Number.NaN, y: 0, width: 1, height: 1 } })).toBe(false);
  });
});

describe('annotation payload validation', () => {
  test('accepts a complete payload', () => {
    expect(isBrowserAnnotationPayload(payload)).toBe(true);
  });

  test('accepts a payload with nothing marked but a comment', () => {
    expect(isBrowserAnnotationPayload({ ...payload, elements: [], regions: [], strokes: [] }))
      .toBe(true);
  });

  test('rejects a payload whose nested element is malformed', () => {
    expect(isBrowserAnnotationPayload({
      ...payload,
      elements: [{ id: 'element-1', element: { ...element, selector: 12 } }],
    })).toBe(false);
  });

  test('rejects a malformed stroke', () => {
    expect(isBrowserAnnotationPayload({
      ...payload,
      strokes: [{ id: 's', points: [{ x: 1 }], bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    })).toBe(false);
  });
});

describe('target geometry', () => {
  test('counts every kind of target', () => {
    expect(annotationTargetCount(payload)).toBe(2);
    expect(annotationTargetCount({ ...payload, elements: [], regions: [], strokes: [] })).toBe(0);
  });
});

// --- backend-neutral control contracts (todo 9) ----------------------------

describe('browser target guard', () => {
  test('accepts directory-only and fully-scoped targets', () => {
    expect(isBrowserTarget({ directory: '/proj' })).toBe(true);
    expect(isBrowserTarget({ directory: '/proj', tabId: 'tab-1', openCodeSessionId: 'ses-1' })).toBe(true);
  });

  test('rejects a target missing its directory', () => {
    expect(isBrowserTarget({ tabId: 'tab-1' })).toBe(false);
    expect(isBrowserTarget({})).toBe(false);
    expect(isBrowserTarget(null)).toBe(false);
    expect(isBrowserTarget('/proj')).toBe(false);
    expect(isBrowserTarget({ directory: 42 })).toBe(false);
  });

  test('rejects wrong-typed optional fields', () => {
    expect(isBrowserTarget({ directory: '/proj', tabId: 7 })).toBe(false);
    expect(isBrowserTarget({ directory: '/proj', openCodeSessionId: null })).toBe(false);
    expect(isBrowserTarget({ directory: '/proj', preferBackend: 3 })).toBe(false);
    expect(isBrowserTarget({ directory: '/proj', preferBackend: 'webkit' })).toBe(false);
  });

  test('accepts a backend force as an optional field', () => {
    expect(isBrowserTarget({ directory: '/proj', preferBackend: 'server-chrome' })).toBe(true);
    expect(isBrowserTarget({ directory: '/proj', preferBackend: 'electron-webview' })).toBe(true);
  });
});

describe('optional server-backend contract fields', () => {
  test('object literals WITHOUT the new fields still satisfy the contracts', () => {
    const target: BrowserTarget = { directory: '/proj' };
    const tab: BrowserTabInfo = { tabId: 'tab-1', url: 'http://a/', title: 'A', active: true };
    const session: BrowserSession = {
      backend: 'electron-webview',
      directory: '/proj',
      tabs: [tab],
      activeTabId: 'tab-1',
    };
    expect(target.directory).toBe('/proj');
    expect(session.backend).toBe('electron-webview');
  });

  test('the new fields are accepted when present', () => {
    const target: BrowserTarget = { directory: '/proj', preferBackend: 'server-chrome' };
    const tab: BrowserTabInfo = {
      tabId: 'sc:ABCD1234', url: 'http://a/', title: 'A', active: true, backend: 'server-chrome',
    };
    const session: BrowserSession = {
      backend: 'server-chrome',
      directory: '/proj',
      tabs: [tab],
      activeTabId: 'sc:ABCD1234',
      sessionId: 'sess-1',
      persistence: 'project',
    };
    expect(target.preferBackend).toBe('server-chrome');
    expect(tab.backend).toBe('server-chrome');
    expect(session.sessionId).toBe('sess-1');
    expect(session.persistence).toBe('project');
    expect(session.tabs[0]?.tabId.startsWith('sc:')).toBe(true);
  });
});

describe('electron webview backend', () => {
  const directory = '/proj';

  const controllerFor = (tabId: string, info?: { url: string; title: string }) => ({
    run: (action: string, parameters: Record<string, unknown>) => Promise.resolve({ action, parameters, tabId }),
    ...(info ? { getInfo: () => ({ tabId, url: info.url, title: info.title }) } : {}),
  });

  const registrationFor = (tabId: string, info?: { url: string; title: string }, tabDirectory = directory) => ({
    key: { runtimeKey: 'runtime', directory: tabDirectory, tabId },
    directoryKey: tabDirectory,
    controller: controllerFor(tabId, info),
  });

  const createBackend = (overrides: Partial<ElectronWebviewBackendDeps> = {}) => (
    createElectronWebviewBackend({
      resolveRegistration: () => null,
      getOpener: () => null,
      listRegistrations: () => [],
      getActiveTarget: () => null,
      canonicalizeDirectory: (value: string) => value.replace(/\/+$/, '') || '/',
      ...overrides,
    })
  );

  const capture = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  test('getSession returns null — not an empty session — for a directory with no controllers', () => {
    const backend = createBackend();
    expect(backend.getSession({ directory: '/nowhere' })).toBe(null);
  });

  test('getSession reads tabs from controller info and marks the active target', () => {
    const visible = registrationFor('tab-1', { url: 'http://a/', title: 'A' });
    const background = registrationFor('tab-2');
    const elsewhere = registrationFor('tab-3', { url: 'http://c/', title: 'C' }, '/other');
    const backend = createBackend({
      listRegistrations: () => [visible, background, elsewhere],
      getActiveTarget: () => visible.key,
    });

    const session = backend.getSession({ directory });
    expect(session).not.toBe(null);
    expect(session?.backend).toBe('electron-webview');
    expect(session?.directory).toBe(directory);
    expect(session?.tabs.length).toBe(2);
    expect(session?.activeTabId).toBe('tab-1');
    const [first, second] = session?.tabs ?? [];
    expect(first).toEqual({ tabId: 'tab-1', url: 'http://a/', title: 'A', active: true });
    expect(second).toEqual({ tabId: 'tab-2', url: '', title: '', active: false });
  });

  test('listTabs scopes to the canonical form of the requested directory', () => {
    const backend = createBackend({
      listRegistrations: () => [registrationFor('tab-1'), registrationFor('tab-2', undefined, '/other')],
    });
    const tabs = backend.listTabs({ directory: '/proj/' });
    expect(tabs.length).toBe(1);
    expect(tabs[0]?.tabId).toBe('tab-1');
  });

  test('execute rejects an unregistered target with a scoped error instead of falling through to another tab', async () => {
    const backend = createBackend({
      listRegistrations: () => [registrationFor('tab-other')],
    });
    const error = await capture(backend.execute({ directory, tabId: 'tab-missing' }, 'browser.click', {}));
    expect(error instanceof Error).toBe(true);
    expect(/no controller for target/.test((error as Error).message)).toBe(true);
    expect((error as Error).message.includes(directory)).toBe(true);
  });

  test('execute runs a controller-resolved action', async () => {
    const registration = registrationFor('tab-1');
    const backend = createBackend({ resolveRegistration: () => registration });
    const result = await backend.execute({ directory, tabId: 'tab-1' }, 'browser.click', { x: 1 });
    expect(result).toEqual({ action: 'browser.click', parameters: { x: 1 }, tabId: 'tab-1' });
  });

  test('a tab-less open with an opener but no controller resolves via the opener', async () => {
    let openedUrl = '';
    const backend = createBackend({
      getOpener: (directoryKey: string) => directoryKey === directory
        ? (url: string) => { openedUrl = url; return { tabId: 'tab-new' }; }
        : null,
    });
    const result = await backend.execute({ directory }, 'browser.open', { url: 'http://a/' });
    expect(openedUrl).toBe('http://a/');
    expect(result).toEqual({ tabId: 'tab-new' });
  });

  test('a tab-less open with a controller in scope uses the controller, never the opener', async () => {
    const registration = registrationFor('tab-1');
    const backend = createBackend({
      resolveRegistration: () => registration,
      getOpener: () => () => { throw new Error('the opener must not run'); },
    });
    const result = await backend.execute({ directory }, 'browser.open', { url: 'http://a/' });
    expect(result).toEqual({ action: 'browser.open', parameters: { url: 'http://a/' }, tabId: 'tab-1' });
  });

  test('an open naming a tab resolves the controller, never the opener', async () => {
    const registration = registrationFor('tab-1');
    const backend = createBackend({
      resolveRegistration: () => registration,
      getOpener: () => () => { throw new Error('the opener must not run'); },
    });
    const result = await backend.execute({ directory, tabId: 'tab-1' }, 'browser.open', { url: 'http://a/' });
    expect(result).toEqual({ action: 'browser.open', parameters: { url: 'http://a/' }, tabId: 'tab-1' });
  });

  test('a tab-less open with neither controller nor opener rejects with the scoped error', async () => {
    const backend = createBackend();
    const error = await capture(backend.execute({ directory }, 'browser.open', { url: 'http://a/' }));
    expect(error instanceof Error).toBe(true);
    expect(/no controller for target/.test((error as Error).message)).toBe(true);
  });

  test('the opener path still requires a url', async () => {
    const backend = createBackend({ getOpener: () => (url: string) => ({ tabId: `tab-${url}` }) });
    const error = await capture(backend.execute({ directory }, 'browser.open', {}));
    expect((error as Error).message).toBe('url is required');
  });
});
