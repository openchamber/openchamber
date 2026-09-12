import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { createDevToolsAssetHandler } from './devtools-assets.js';

const response = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  setHeader(name, value) { this.headers[name] = value; },
  status(value) { this.statusCode = value; return this; },
  send(value) { this.body = value; return this; },
  end(value) { this.body = value ?? null; return this; },
});

describe('DevTools frontend asset handler', () => {
  it('serves only granted static DevTools paths and never proxies debug metadata', async () => {
    const fetchAsset = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/javascript; charset=utf-8', 'content-length': '17' }),
      arrayBuffer: async () => new TextEncoder().encode('export default 1;').buffer,
    }));
    const assets = createDevToolsAssetHandler({ fetchAsset, randomBytes: () => Buffer.alloc(24, 7) });
    const grant = assets.grant('ws://127.0.0.1:9222/devtools/browser/private');
    const ok = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/entrypoints/inspector/inspector.js` }, ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(ok.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(fetchAsset).toHaveBeenCalledWith('http://127.0.0.1:9222/devtools/entrypoints/inspector/inspector.js');
    for (const path of ['../json/version', '%2e%2e/json', '%252e%252e/json/version', 'json/protocol', 'devtools/browser/private']) {
      const rejected = response();
      await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/${path}` }, rejected);
      expect(rejected.statusCode).toBe(404);
    }
    assets.revoke(grant);
    const revoked = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/entrypoints/inspector/inspector.js` }, revoked);
    expect(revoked.statusCode).toBe(404);
  });

  it('serves an owned bootstrap and bridge bound to the exact parent origin and attachment identity', async () => {
    const assets = createDevToolsAssetHandler({ fetchAsset: vi.fn(), randomBytes: () => Buffer.alloc(24, 9) });
    const grant = assets.grant('ws://127.0.0.1:9222/devtools/browser/private');
    const html = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/inspector.html` }, html);
    expect(String(html.body)).toContain('bridge.js');
    expect(String(html.body)).not.toContain('src="entrypoints/inspector/inspector.js"');
    expect(String(html.body)).toContain('application_tokens.css');
    expect(String(html.body)).toContain('design_system_tokens.css');
    expect(String(html.body)).toContain("connect-src 'self' data:");
    const bridge = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/bridge.js` }, bridge);
    expect(String(bridge.body)).toContain('event.source !== parent');
    expect(String(bridge.body)).toContain('event.origin !== expectedOrigin');
    expect(String(bridge.body)).toContain("postStatus('openchamber-devtools-ready')");
    expect(String(bridge.body)).toContain("postStatus('openchamber-devtools-loaded')");
    expect(String(bridge.body)).toContain("import * as Common from './core/common/common.js'");
    expect(String(bridge.body)).toContain("import * as Host from './core/host/host.js'");
    expect(String(bridge.body)).toContain("import * as ThemeSupport from './ui/legacy/theme_support/theme_support.js'");
    expect(String(bridge.body)).toContain("import('./entrypoints/devtools_app/devtools_app.js')");
    expect(String(bridge.body)).not.toContain("import('./entrypoints/inspector/inspector.js')");
    expect(String(bridge.body)).not.toContain('globalThis.InspectorFrontendHost = {');
    expect(String(bridge.body)).toContain('port.postMessage(message)');
    expect(String(bridge.body)).toContain('dispatch(value)');
    expect(String(bridge.body)).not.toContain("postMessage('*'");
    expect(String(bridge.body)).not.toContain("{ type: 'cdp', message }");
  });

  it('enables software menus before loading DevTools and reports transport readiness separately from completed UI load', async () => {
    const assets = createDevToolsAssetHandler({ fetchAsset: vi.fn(), randomBytes: () => Buffer.alloc(24, 9) });
    const grant = assets.grant('ws://127.0.0.1:9222/devtools/browser/private');
    const bridge = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/bridge.js` }, bridge);
    const parent = { postMessage: vi.fn() };
    const listeners = new Map();
    const loadCompleted = vi.fn();
    const initializedHost = {
      recordedEnumeratedHistograms: [],
      recordedPerformanceHistograms: [],
      isHostedMode: () => true,
      loadCompleted,
    };
    const dispatchMessage = vi.fn();
    const contextMenu = { useSoftMenu: false };
    const loadInspector = vi.fn(() => {
      expect(contextMenu.useSoftMenu).toBe(true);
      expect(initializedHost.isHostedMode()).toBe(false);
    });
    const clearThemeCache = vi.fn();
    const dispatchThemeEvent = vi.fn();
    class ThemeChangeEvent {}
    let uiTheme = 'dark';
    let themeSupportReady = false;
    const setUiTheme = vi.fn((value) => { uiTheme = value; });
    const rootClasses = new Set();
    const rootStyles = new Map();
    const root = {
      classList: {
        toggle(name, enabled) { if (enabled) rootClasses.add(name); else rootClasses.delete(name); },
        contains(name) { return rootClasses.has(name); },
      },
      style: {
        setProperty(name, value) { rootStyles.set(name, value); },
      },
    };
    const context = {
      URLSearchParams, TextEncoder,
      location: { search: '?parentOrigin=https%3A%2F%2Fopenchamber.test&devtoolsId=devtools-a&attachmentRequestId=attach-a' },
      parent,
      addEventListener: (name, listener) => listeners.set(name, listener),
      document: { documentElement: root },
      CSS: { supports: (property, value) => property === 'color' && /^#[\dA-Fa-f]{6}$/.test(value) },
      MutationObserver: class { observe() {} },
      InspectorFrontendAPI: { dispatchMessage },
      __commonModule: {
        Settings: { Settings: { instance: () => ({
          moduleSetting: (name) => {
            if (name !== 'ui-theme') throw new Error(`Unexpected setting: ${name}`);
            return { get: () => uiTheme, set: setUiTheme };
          },
        }) } },
      },
      __hostModule: { InspectorFrontendHost: { InspectorFrontendHostInstance: initializedHost } },
      __uiModule: { ContextMenu: { ContextMenu: contextMenu } },
      __themeSupportModule: {
        ThemeSupport: {
          hasInstance: () => themeSupportReady,
          clearThemeCache,
          instance: () => ({ dispatchEvent: dispatchThemeEvent }),
        },
        ThemeChangeEvent,
      },
      __loadInspector: loadInspector,
    };
    const executable = String(bridge.body)
      .replace("import * as Common from './core/common/common.js';", 'const Common = globalThis.__commonModule;')
      .replace("import * as Host from './core/host/host.js';", 'const Host = globalThis.__hostModule;')
      .replace("import * as UI from './ui/legacy/legacy.js';", 'const UI = globalThis.__uiModule;')
      .replace("import * as ThemeSupport from './ui/legacy/theme_support/theme_support.js';",
        'const ThemeSupport = globalThis.__themeSupportModule;')
      .replace("void import('./entrypoints/devtools_app/devtools_app.js');", 'globalThis.__loadInspector();');
    vm.runInNewContext(executable, context);
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'openchamber-devtools-ready', devtoolsId: 'devtools-a', attachmentRequestId: 'attach-a',
    }, 'https://openchamber.test');
    expect(loadInspector).toHaveBeenCalledOnce();
    expect(initializedHost.recordedEnumeratedHistograms).toEqual([]);
    expect(initializedHost.recordedPerformanceHistograms).toEqual([]);
    expect(initializedHost.isHostedMode()).toBe(false);
    const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
    listeners.get('message')({
      source: parent, origin: 'https://openchamber.test', ports: [port],
      data: { type: 'openchamber-devtools-connect', devtoolsId: 'devtools-a', attachmentRequestId: 'attach-a' },
    });
    initializedHost.sendMessageToBackend('{"id":1}');
    expect(port.postMessage).toHaveBeenCalledWith('{"id":1}');
    port.onmessage({ data: '{"id":2,"result":{}}' });
    expect(dispatchMessage).toHaveBeenCalledWith('{"id":2,"result":{}}');
    const themeMessage = {
      type: 'openchamber-devtools-theme', variant: 'dark', colors: {
        background: '#101010', container: '#202020', elevated: '#303030', foreground: '#eeeeee',
        mutedForeground: '#aaaaaa', divider: '#404040', selection: '#505050', selectionForeground: '#ffffff',
        focus: '#606060', hover: '#707070', active: '#808080', primary: '#909090', primaryForeground: '#000000',
        error: '#aa0000', errorForeground: '#ffffff', errorBackground: '#330000', warning: '#aa7700',
        warningForeground: '#ffffff', warningBackground: '#332200', success: '#00aa00', info: '#0077aa',
        syntaxForeground: '#dddddd', syntaxComment: '#777777', syntaxKeyword: '#cc77ff', syntaxString: '#77cc88',
        syntaxNumber: '#ffaa55', syntaxFunction: '#55aaff', syntaxVariable: '#dddddd', syntaxType: '#55cccc',
        syntaxOperator: '#ff7799',
      },
    };
    port.onmessage({ data: themeMessage });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(rootClasses.has('theme-with-dark-background')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    expect(rootStyles.get('--sys-color-cdt-base')).toBe('#101010');
    expect(rootStyles.get('--sys-color-tonal-container')).toBe('#505050');
    expect(rootStyles.get('--sys-color-token-keyword')).toBe('#cc77ff');
    expect(setUiTheme).not.toHaveBeenCalled();
    expect(clearThemeCache).not.toHaveBeenCalled();
    expect(dispatchThemeEvent).not.toHaveBeenCalled();
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'openchamber-devtools-themed', devtoolsId: 'devtools-a', attachmentRequestId: 'attach-a',
    }, 'https://openchamber.test');
    port.onmessage({ data: { ...themeMessage, colors: { ...themeMessage.colors, background: 'red; display: none' } } });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(rootStyles.get('--sys-color-cdt-base')).toBe('#101010');
    expect(setUiTheme).not.toHaveBeenCalled();
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'openchamber-devtools-theme-rejected', devtoolsId: 'devtools-a', attachmentRequestId: 'attach-a',
    }, 'https://openchamber.test');
    rootClasses.delete('theme-with-dark-background');
    rootStyles.delete('--sys-color-cdt-base');
    themeSupportReady = true;
    initializedHost.loadCompleted();
    expect(loadCompleted).toHaveBeenCalledOnce();
    expect(rootClasses.has('theme-with-dark-background')).toBe(true);
    expect(rootStyles.get('--sys-color-cdt-base')).toBe('#101010');
    expect(setUiTheme).toHaveBeenCalledOnce();
    expect(setUiTheme).toHaveBeenCalledWith('dark');
    expect(uiTheme).toBe('dark');
    expect(clearThemeCache).toHaveBeenCalledOnce();
    expect(dispatchThemeEvent).toHaveBeenCalledOnce();
    expect(dispatchThemeEvent.mock.calls[0][0]).toBeInstanceOf(ThemeChangeEvent);
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'openchamber-devtools-loaded', devtoolsId: 'devtools-a', attachmentRequestId: 'attach-a',
    }, 'https://openchamber.test');
  });

  it('fails oversized or redirected assets instead of truncating them', async () => {
    const assets = createDevToolsAssetHandler({
      fetchAsset: async () => ({ ok: false, status: 302, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }),
      randomBytes: () => Buffer.alloc(24, 3),
    });
    const grant = assets.grant('ws://127.0.0.1:9222/devtools/browser/private');
    const res = response();
    await assets.handle({ method: 'GET', originalUrl: `/api/browser-devtools/${grant}/entrypoints/main/main.js` }, res);
    expect(res.statusCode).toBe(502);
    const oversized = createDevToolsAssetHandler({
      fetchAsset: async () => ({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'text/javascript', 'content-length': String(64 * 1024 * 1024 + 1) }),
        arrayBuffer: async () => { throw new Error('must not read oversized response'); },
      }),
      randomBytes: () => Buffer.alloc(24, 4),
    });
    const oversizedGrant = oversized.grant('ws://127.0.0.1:9222/devtools/browser/private');
    const oversizedResponse = response();
    await oversized.handle({
      method: 'GET', originalUrl: `/api/browser-devtools/${oversizedGrant}/entrypoints/main/main.js`,
    }, oversizedResponse);
    expect(oversizedResponse.statusCode).toBe(502);
  });
});
