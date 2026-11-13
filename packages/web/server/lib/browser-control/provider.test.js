import { describe, expect, test } from 'bun:test';

import { BROWSER_PROVIDER_IDLE_MS, BROWSER_PROVIDER_OPEN_TIMEOUT_MS, BROWSER_PROVIDER_PATH } from '@openchamber/sdk';

import { BrowserControlError } from './broker.js';
import { createBrowserControlRouter, isBrowserProviderGuest } from './provider.js';
import { GuestServiceError } from '../guests/service.js';

const providerGuest = (overrides = {}) => ({
  id: 'server-chrome',
  name: 'Server Chrome',
  packageRoot: '/ext/server-chrome',
  enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'] },
  capabilityGrants: ['service'],
  panel: { id: 'server-chrome', name: 'Server Chrome', icon: 'window' },
  ...overrides,
});

const surfaceProviderGuest = (overrides = {}) => providerGuest({
  service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'], surface: true },
  ...overrides,
});

const createRouter = ({
  settings = { browserProvider: 'server-chrome' },
  guest = providerGuest(),
  serviceAnswer = { status: 200, body: JSON.stringify({ ok: true, data: { url: 'http://localhost:3000/', title: 'App' } }) },
  userControls = false,
  readSettingsError = null,
  findGuestError = null,
  notifyBrowserHelp,
} = {}) => {
  const brokerCalls = [];
  const proxied = [];
  const persisted = [];
  const resets = [];
  const agentActivity = [];
  const helpNotifications = [];
  const announced = [];
  let current = { ...settings };
  const router = createBrowserControlRouter({
    surfaceControl: {
      userControls: () => userControls,
      noteAgentActivity: (guestId) => agentActivity.push(guestId),
    },
    broker: {
      request: async (action, parameters, options) => {
        brokerCalls.push({ action, parameters, options });
        return { from: 'broker' };
      },
    },
    readSettings: async () => {
      if (readSettingsError) throw readSettingsError;
      return current;
    },
    persistSettings: async (changes) => {
      persisted.push(changes);
      current = { ...current, ...changes };
    },
    findGuest: async (id) => {
      if (findGuestError) throw findGuestError;
      return guest && guest.id === id ? guest : null;
    },
    persistPath: '/data/extensions.json',
    emitProviderReset: (event) => resets.push(event),
    createId: () => 'req-1',
    proxyServiceRequest: async (params) => {
      proxied.push(params);
      if (serviceAnswer instanceof Error) throw serviceAnswer;
      return serviceAnswer;
    },
    notifyBrowserHelp: notifyBrowserHelp ?? (async (event) => {
      helpNotifications.push(event);
    }),
    announceAgentActivity: (event) => announced.push(event),
  });
  return { router, brokerCalls, proxied, persisted, resets, agentActivity, helpNotifications, announced };
};

describe('isBrowserProviderGuest', () => {
  test('needs enabled, approved, and the browser role', () => {
    expect(isBrowserProviderGuest(providerGuest())).toBe(true);
    expect(isBrowserProviderGuest(providerGuest({ enabled: false }))).toBe(false);
    expect(isBrowserProviderGuest(providerGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isBrowserProviderGuest(providerGuest({ service: { entry: 'service/main.js', runtime: 'host' } }))).toBe(false);
    expect(isBrowserProviderGuest(null)).toBe(false);
  });
});

describe('browser control router', () => {
  test('announces each provider action with its chat, except closing a tab and actions the user blocks', async () => {
    const context = { directory: '/repo', sessionId: 'ses_1' };
    const { router, announced } = createRouter();
    await router.request('browser.open', { url: 'http://localhost:3000/' }, { context });
    await router.request('browser.close', {}, { context });
    expect(announced).toEqual([{ guestId: 'server-chrome', action: 'browser.open', context }]);

    const blocked = createRouter({ userControls: true });
    await expect(blocked.router.request('browser.snapshot', {}, { context })).rejects.toThrow(/interacting with this page/);
    expect(blocked.announced).toEqual([]);

    const builtin = createRouter({ settings: { browserProvider: 'builtin' } });
    await builtin.router.request('browser.snapshot', {}, { context });
    expect(builtin.announced).toEqual([]);
  });

  test('an unset setting resolves to the built-in Server Browser extension, not the in-app broker', async () => {
    const builtinGuest = providerGuest({ id: 'openchamber-builtin-server-browser', name: 'Server Browser' });
    const { router, brokerCalls, proxied } = createRouter({ settings: {}, guest: builtinGuest });
    const result = await router.request('browser.snapshot', {}, { timeoutMs: 20_000 });
    expect(result).toEqual({ url: 'http://localhost:3000/', title: 'App' });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].guestId).toBe('openchamber-builtin-server-browser');
  });

  test('an unset setting with no built-in guest registered runs in-app, the same as an unusable selection', async () => {
    const { router, brokerCalls, proxied, resets } = createRouter({ settings: {}, guest: providerGuest({ id: 'something-else' }) });
    const result = await router.request('browser.snapshot', {}, { timeoutMs: 20_000 });
    expect(result).toEqual({ from: 'broker' });
    expect(brokerCalls).toHaveLength(1);
    expect(proxied).toHaveLength(0);
    expect(resets).toEqual([{ guestId: 'openchamber-builtin-server-browser', guestName: 'openchamber-builtin-server-browser' }]);
  });

  test('"builtin" is the in-app broker as well', async () => {
    const { router, brokerCalls } = createRouter({ settings: { browserProvider: 'builtin' } });
    await router.request('browser.snapshot', {});
    expect(brokerCalls).toHaveLength(1);
  });

  test('posts the action to the selected provider service and returns its data', async () => {
    const { router, brokerCalls, proxied } = createRouter();
    const result = await router.request('browser.open', { url: 'http://localhost:3000/' }, {
      timeoutMs: 45_000,
      context: { directory: '/repo', sessionId: 'ses_1' },
    });
    expect(result).toEqual({ url: 'http://localhost:3000/', title: 'App' });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(1);
    const call = proxied[0];
    expect(call.guestId).toBe('server-chrome');
    expect(call.method).toBe('POST');
    expect(call.path).toBe(BROWSER_PROVIDER_PATH);
    expect(JSON.parse(call.body)).toEqual({
      requestId: 'req-1',
      action: 'browser.open',
      parameters: { url: 'http://localhost:3000/' },
      context: { directory: '/repo', sessionId: 'ses_1' },
    });
    expect(call.idleStopMs).toBe(BROWSER_PROVIDER_IDLE_MS);
    expect(call.granted).toEqual(['service']);
  });

  test('routes browser.select to the selected provider unchanged', async () => {
    const { router, proxied } = createRouter({
      serviceAnswer: {
        status: 200,
        body: JSON.stringify({ ok: true, data: { selector: '#country', label: 'Canada', value: 'ca', url: 'https://example.test/' } }),
      },
    });

    await expect(router.request('browser.select', { selector: '#country', label: 'Canada' })).resolves.toEqual({
      selector: '#country',
      label: 'Canada',
      value: 'ca',
      url: 'https://example.test/',
    });
    expect(JSON.parse(proxied[0].body).action).toBe('browser.select');
    expect(JSON.parse(proxied[0].body).parameters).toEqual({ selector: '#country', label: 'Canada' });
  });

  test('a slow page gets the open budget when the caller sets none', async () => {
    const { router, proxied } = createRouter();
    await router.request('browser.open', { url: 'http://a/' });
    expect(proxied[0].timeoutMs).toBe(BROWSER_PROVIDER_OPEN_TIMEOUT_MS);
  });

  test('a provider error becomes the agent-visible error, not a transport failure', async () => {
    const { router } = createRouter({
      serviceAnswer: { status: 200, body: JSON.stringify({ ok: false, error: 'No element matches #save' }) },
    });
    try {
      await router.request('browser.click', { selector: '#save' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.message).toBe('No element matches #save');
      expect(error.status).toBe(400);
    }
  });

  test('a non-200 or malformed answer is reported as unknown page state', async () => {
    for (const serviceAnswer of [
      { status: 500, body: 'boom' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]) {
      const { router } = createRouter({ serviceAnswer });
      await expect(router.request('browser.snapshot', {})).rejects.toMatchObject({ status: 502 });
    }
  });

  test('a service that will not start tells the agent nothing changed', async () => {
    const { router } = createRouter({
      serviceAnswer: new GuestServiceError('Guest service failed to become ready.', 'SERVICE_FAILED'),
    });
    try {
      await router.request('browser.snapshot', {});
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.status).toBe(503);
      expect(error.message).toContain('Server Chrome');
      expect(error.message).toContain('Nothing was changed');
    }
  });

  test('a selected extension that cannot serve resets the setting, tells clients, and runs in-app', async () => {
    const { router, brokerCalls, persisted, resets } = createRouter({ guest: providerGuest({ enabled: false }) });
    const result = await router.request('browser.snapshot', {});
    expect(result).toEqual({ from: 'broker' });
    expect(brokerCalls).toHaveLength(1);
    expect(persisted).toEqual([{ browserProvider: 'builtin' }]);
    expect(resets).toEqual([{ guestId: 'server-chrome', guestName: 'Server Chrome' }]);
  });

  test('a removed extension resets by id when no name is known', async () => {
    const { router, resets } = createRouter({ guest: null });
    await router.request('browser.snapshot', {});
    expect(resets).toEqual([{ guestId: 'server-chrome', guestName: 'server-chrome' }]);
  });

  test('deactivating the selected extension resets right away; another one does not', async () => {
    const { router, persisted, resets } = createRouter();
    expect(await router.handleGuestDeactivated({ guestId: 'other', guestName: 'Other' })).toBe(false);
    expect(persisted).toHaveLength(0);
    expect(await router.handleGuestDeactivated({ guestId: 'server-chrome', guestName: 'Server Chrome' })).toBe(true);
    expect(persisted).toEqual([{ browserProvider: 'builtin' }]);
    expect(resets).toEqual([{ guestId: 'server-chrome', guestName: 'Server Chrome' }]);
  });

  test('an action is refused while the user drives the shared surface', async () => {
    const { router, proxied, agentActivity } = createRouter({ userControls: true });
    try {
      await router.request('browser.click', { selector: '#save' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.status).toBe(409);
      expect(error.message).toContain('Nothing was changed');
    }
    expect(proxied).toHaveLength(0);
    expect(agentActivity).toHaveLength(0);
  });

  test('a provider action counts as agent activity on the surface', async () => {
    const { router, agentActivity } = createRouter();
    await router.request('browser.snapshot', {});
    expect(agentActivity).toEqual(['server-chrome']);
  });

  test('a settings read that fails runs nothing anywhere and changes nothing', async () => {
    const { router, brokerCalls, proxied, persisted, resets } = createRouter({ readSettingsError: new Error('disk') });
    await expect(router.request('browser.click', { selector: '#save' })).rejects.toMatchObject({ status: 503 });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    expect(resets).toHaveLength(0);
  });

  test('a catalog read that fails runs nothing anywhere and keeps the choice', async () => {
    const { router, brokerCalls, proxied, persisted, resets } = createRouter({ findGuestError: new Error('catalog') });
    await expect(router.request('browser.click', { selector: '#save' })).rejects.toMatchObject({ status: 503 });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    expect(resets).toHaveLength(0);
  });

  test('a request that was sent and lost is reported as unknown, not as unchanged', async () => {
    const { router } = createRouter({
      serviceAnswer: new GuestServiceError('Guest service request failed.', 'REQUEST_FAILED'),
    });
    try {
      await router.request('browser.click', { selector: '#save' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.status).toBe(504);
      expect(error.message).toContain('may or may not have run');
      expect(error.message).not.toContain('Nothing was changed');
    }
  });

  test('browser.requestHelp refuses with a clear 400 when the in-app browser would answer', async () => {
    const { router, brokerCalls, proxied } = createRouter({ settings: {} });
    await expect(router.request('browser.requestHelp', { reason: 'Sign in', timeoutSeconds: 300 }))
      .rejects.toMatchObject({
        status: 400,
        message: 'Asking for help needs a browser provider extension with a shared surface (Settings → OpenChamber Tools → Browser provider).',
      });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(0);
  });

  test('browser.requestHelp refuses with the same 400 when a selected extension cannot serve', async () => {
    const { router, brokerCalls, resets } = createRouter({ guest: providerGuest({ enabled: false }) });
    await expect(router.request('browser.requestHelp', { reason: 'Sign in', timeoutSeconds: 300 }))
      .rejects.toMatchObject({ status: 400 });
    expect(brokerCalls).toHaveLength(0);
    expect(resets).toEqual([{ guestId: 'server-chrome', guestName: 'Server Chrome' }]);
  });

  test('browser.requestHelp refuses when the selected provider has no shared surface', async () => {
    const { router, proxied } = createRouter({ guest: providerGuest() });
    await expect(router.request('browser.requestHelp', { reason: 'Sign in', timeoutSeconds: 300 }))
      .rejects.toMatchObject({
        status: 400,
        message: 'Asking for help needs a browser provider extension with a shared surface (Settings → OpenChamber Tools → Browser provider).',
      });
    expect(proxied).toHaveLength(0);
  });

  test('browser.requestHelp notifies the user before proxying, after the surface 409 check', async () => {
    const { router, proxied, helpNotifications } = createRouter({
      guest: surfaceProviderGuest(),
      serviceAnswer: { status: 200, body: JSON.stringify({ ok: true, data: { outcome: 'timeout', url: 'http://a/', title: 'A', waitedSeconds: 300 } }) },
    });
    const result = await router.request(
      'browser.requestHelp',
      { reason: 'Sign in with Google', timeoutSeconds: 300 },
      { context: { directory: '/repo', sessionId: 'ses_1' }, timeoutMs: 315_000 },
    );
    expect(result).toEqual({ outcome: 'timeout', url: 'http://a/', title: 'A', waitedSeconds: 300 });
    expect(helpNotifications).toEqual([{
      guestId: 'server-chrome',
      guestName: 'Server Chrome',
      reason: 'Sign in with Google',
      kind: undefined,
      context: { directory: '/repo', sessionId: 'ses_1' },
    }]);
    expect(proxied).toHaveLength(1);
  });

  test('browser.requestHelp passes kind through to notifyBrowserHelp', async () => {
    const { router, helpNotifications } = createRouter({
      guest: surfaceProviderGuest(),
      serviceAnswer: { status: 200, body: JSON.stringify({ ok: true, data: { outcome: 'signed-in', url: 'http://a/', title: 'A', waitedSeconds: 10 } }) },
    });
    await router.request('browser.requestHelp', { reason: 'Sign in to your account', timeoutSeconds: 300, kind: 'login' });
    expect(helpNotifications[0]).toMatchObject({ kind: 'login' });
  });

  test('browser.requestHelp is refused with 409 while the user drives the surface, and nobody is notified', async () => {
    const { router, proxied, helpNotifications } = createRouter({ guest: surfaceProviderGuest(), userControls: true });
    await expect(router.request('browser.requestHelp', { reason: 'Sign in', timeoutSeconds: 300 }))
      .rejects.toMatchObject({ status: 409 });
    expect(proxied).toHaveLength(0);
    expect(helpNotifications).toHaveLength(0);
  });

  test('a notifyBrowserHelp failure is logged, and the action still runs', async () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const { router, proxied } = createRouter({
        guest: surfaceProviderGuest(),
        notifyBrowserHelp: async () => {
          throw new Error('push service unavailable');
        },
      });
      const result = await router.request('browser.requestHelp', { reason: 'Sign in', timeoutSeconds: 300 });
      expect(result).toEqual({ url: 'http://localhost:3000/', title: 'App' });
      expect(proxied).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
    expect(warnings.some((line) => line.includes('push service unavailable'))).toBe(true);
  });

  test('a settings read that fails during deactivation is logged, not raised', async () => {
    const { router, persisted } = createRouter({ readSettingsError: new Error('disk') });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await router.handleGuestDeactivated({ guestId: 'server-chrome', guestName: 'Server Chrome' })).toBe(false);
    } finally {
      console.warn = warn;
    }
    expect(persisted).toHaveLength(0);
  });

  test('browser.dialog refuses with a clear 400 when the in-app browser would answer', async () => {
    const { router, brokerCalls, proxied } = createRouter({ settings: { browserProvider: 'builtin' } });
    await expect(router.request('browser.dialog', { accept: true }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('answer their own dialogs') });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(0);
  });

  test('browser.saveProfile refuses with a clear 400 when the in-app browser would answer', async () => {
    const { router, brokerCalls, proxied } = createRouter({ settings: {} });
    await expect(router.request('browser.saveProfile', {}))
      .rejects.toMatchObject({
        status: 400,
        message: 'Saving a browser profile needs the Server Browser extension (Settings → OpenChamber Tools → Browser provider).',
      });
    expect(brokerCalls).toHaveLength(0);
    expect(proxied).toHaveLength(0);
  });

  test('browser.saveProfile refuses with the same 400 when a selected extension cannot serve', async () => {
    const { router, brokerCalls, resets } = createRouter({ guest: providerGuest({ enabled: false }) });
    await expect(router.request('browser.saveProfile', {}))
      .rejects.toMatchObject({ status: 400 });
    expect(brokerCalls).toHaveLength(0);
    expect(resets).toEqual([{ guestId: 'server-chrome', guestName: 'Server Chrome' }]);
  });

  test('browser.saveProfile needs no shared surface, unlike requestHelp', async () => {
    const { router, proxied } = createRouter({
      guest: providerGuest(),
      serviceAnswer: { status: 200, body: JSON.stringify({ ok: true, data: { saved: true, profile: 'default', version: 2, reopenedTabs: 1 } }) },
    });
    const result = await router.request('browser.saveProfile', {});
    expect(result).toEqual({ saved: true, profile: 'default', version: 2, reopenedTabs: 1 });
    expect(proxied).toHaveLength(1);
  });

  test('browser.saveProfile does not notify the user', async () => {
    const { router, helpNotifications } = createRouter({
      guest: providerGuest(),
      serviceAnswer: { status: 200, body: JSON.stringify({ ok: true, data: { saved: true, profile: 'default', version: 2, reopenedTabs: 0 } }) },
    });
    await router.request('browser.saveProfile', {});
    expect(helpNotifications).toHaveLength(0);
  });
});
