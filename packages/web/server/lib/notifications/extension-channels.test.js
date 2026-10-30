import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOutboundHandles } from '../source-control/outbound-handles.js';
import { createNotificationChannelAccounts, notificationChannelsPersistPath } from './channel-accounts.js';
import { createExtensionNotificationChannels, isNotificationChannelGuest, normalizeChannelInstance } from './extension-channels.js';

const slack = {
  label: 'Slack',
  instances: { kind: 'fixed', origin: 'https://slack.com' },
  token: { header: 'authorization', scheme: 'bearer', scopes: ['chat:write'] },
};

const channelGuest = (overrides = {}) => ({
  id: 'slack-bridge', name: 'Slack Bridge', packageRoot: '/pkg/slack', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['notifications'] },
  notifications: slack,
  capabilityGrants: ['service'],
  ...overrides,
});

const notification = { kind: 'ready', title: 'Done', body: 'The parser passes.', tag: 'ready-ses_1', at: 1, sessionId: 'ses_1', sessionName: 'Fix', directory: '/repo', url: '/?session=ses_1' };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** A runtime over a real account store and real handles, with a scripted service and server. */
const harness = async ({ catalog = [channelGuest()], visible = false, server = async () => new Response('{}', { status: 200 }) } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-channels-'));
  const accounts = createNotificationChannelAccounts({ persistPath: notificationChannelsPersistPath(dir) });
  const handles = createOutboundHandles({ fetch: server });
  const calls = [];
  const warnings = [];
  /** What the scripted service answers per method; a test overrides entries. */
  const answers = {
    'auth.probe': () => ({ ok: true, data: { supported: true } }),
    'auth.verify': () => ({ ok: true, data: { account: { id: 'U1', login: 'mona', name: 'Mona' } } }),
    notify: () => ({ ok: true, data: { delivered: true } }),
  };
  let proxyFailure = null;
  const proxy = async (params) => {
    const request = JSON.parse(params.body);
    calls.push({ params, request });
    if (proxyFailure) throw proxyFailure;
    const answer = await answers[request.method](request, params);
    return typeof answer === 'string' ? { status: 200, body: answer } : { status: 200, body: JSON.stringify(answer) };
  };
  const channels = createExtensionNotificationChannels({
    listGuests: async () => catalog,
    proxyServiceRequest: proxy,
    persistPath: '/data/extensions.json',
    accounts,
    handles,
    isAnyUiVisible: () => visible,
    createId: (() => { let n = 0; return () => `req-${n += 1}`; })(),
    warn: (...args) => warnings.push(args.join(' ')),
  });
  await channels.reconcile();
  return {
    channels, accounts, handles, calls, warnings, answers, catalog,
    failProxyWith: (error) => { proxyFailure = error; },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

describe('isNotificationChannelGuest', () => {
  test('needs an enabled, fully approved package with the role and its contribution', () => {
    expect(isNotificationChannelGuest(channelGuest())).toBe(true);
    expect(isNotificationChannelGuest(channelGuest({ enabled: false }))).toBe(false);
    expect(isNotificationChannelGuest(channelGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isNotificationChannelGuest(channelGuest({ notifications: undefined }))).toBe(false);
    expect(isNotificationChannelGuest(channelGuest({ service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'] } }))).toBe(false);
  });

  test('a typed instance is an https origin, or http on this machine', () => {
    expect(normalizeChannelInstance('https://matrix.example.org/')).toBe('https://matrix.example.org');
    expect(normalizeChannelInstance(' https://matrix.example.org ')).toBe('https://matrix.example.org');
    expect(normalizeChannelInstance('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567');
    expect(normalizeChannelInstance('http://matrix.example.org')).toBeNull();
    expect(normalizeChannelInstance('https://matrix.example.org/_matrix')).toBeNull();
    expect(normalizeChannelInstance('https://user:pw@matrix.example.org')).toBeNull();
    expect(normalizeChannelInstance('matrix.example.org')).toBeNull();
    expect(normalizeChannelInstance(7)).toBeNull();
  });
});

describe('connecting an account', () => {
  test('Disconnect wins over a Connect whose verification is still pending', async () => {
    const h = await harness();
    const started = deferred();
    const gate = deferred();
    try {
      h.answers['auth.verify'] = async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, data: { account: { id: 'U1', login: 'mona' } } };
      };
      const connecting = h.channels.connect({ providerId: 'ext-slack-bridge', token: 'old' });
      const outcome = connecting.catch((error) => error);
      await started.promise;
      await h.channels.disconnect({ providerId: 'ext-slack-bridge' });
      gate.resolve();
      expect(await outcome).toMatchObject({ status: 409, code: 'CONNECT_SUPERSEDED' });
      expect(await h.accounts.read('ext-slack-bridge')).toBeNull();
    } finally { gate.resolve(); await h.cleanup(); }
  });

  test('probes, verifies through the service with a handle that carries the token, and stores what the server said', async () => {
    const h = await harness();
    try {
      expect(await h.channels.list()).toEqual([{ providerId: 'ext-slack-bridge', guestId: 'slack-bridge', name: 'Slack Bridge', channel: {
        label: 'Slack', instances: { kind: 'fixed', origin: 'https://slack.com' }, token: { scheme: 'bearer', username: false, scopes: ['chat:write'] },
      }, account: null }]);
      const view = await h.channels.connect({ providerId: 'ext-slack-bridge', token: ' xoxb-secret ' });
      expect(view).toMatchObject({ instance: 'https://slack.com', account: { id: 'U1', login: 'mona', name: 'Mona', status: 'valid' } });
      expect(h.calls.map((call) => call.request.method)).toEqual(['auth.probe', 'auth.verify']);
      const [probe, verify] = h.calls;
      expect(probe.params).toMatchObject({ guestId: 'slack-bridge', path: '/notifications', method: 'POST', timeoutMs: 15_000, granted: ['service'] });
      expect(probe.request).toMatchObject({ v: 1, requestId: 'req-1', provider: 'ext-slack-bridge', session: { instance: 'https://slack.com', account: null }, input: {} });
      expect(typeof verify.request.session.handle).toBe('string');
      // The handle ended with the call.
      expect(h.handles.refusal(verify.request.session.handle)).toMatchObject({ status: 403 });
      expect(JSON.stringify(h.calls)).not.toContain('xoxb-secret');
      expect((await h.accounts.read('ext-slack-bridge'))?.account.token).toBe('xoxb-secret');
      expect((await h.channels.list())[0].account).toEqual(view);
    } finally { await h.cleanup(); }
  });

  test('refuses what cannot be connected before anything is sent', async () => {
    const h = await harness({ catalog: [channelGuest(), channelGuest({
      id: 'matrix', name: 'Matrix', packageRoot: '/pkg/matrix',
      notifications: { label: 'Matrix', instances: { kind: 'user', label: 'Homeserver' }, token: { header: 'authorization', scheme: 'basic', username: true } },
    })] });
    try {
      await expect(h.channels.connect({ providerId: 'ext-nope', token: 't' })).rejects.toMatchObject({ status: 404, code: 'CHANNEL_UNKNOWN' });
      await expect(h.channels.connect({ providerId: 'ext-slack-bridge', token: '  ' })).rejects.toMatchObject({ status: 400, code: 'TOKEN_REQUIRED' });
      await expect(h.channels.connect({ providerId: 'ext-matrix', token: 't' })).rejects.toMatchObject({ status: 400, code: 'USERNAME_REQUIRED' });
      await expect(h.channels.connect({ providerId: 'ext-matrix', token: 't', username: 'mona', instance: 'matrix.example.org' })).rejects.toMatchObject({ status: 400, code: 'INSTANCE_REQUIRED' });
      await expect(h.channels.connect({ providerId: 'ext-matrix', token: 't', username: 'jö:rg', instance: 'https://matrix.example.org' })).rejects.toMatchObject({ status: 400, code: 'USERNAME_INVALID' });
      expect(h.calls).toHaveLength(0);
      const view = await h.channels.connect({ providerId: 'ext-matrix', token: 't', username: 'mona', instance: 'https://matrix.example.org/' });
      expect(view).toMatchObject({ instance: 'https://matrix.example.org', account: { id: 'U1', login: 'mona' } });
    } finally { await h.cleanup(); }
  });

  test('an unsupported instance, a refused token and an unreachable service answer as the card needs', async () => {
    const h = await harness();
    try {
      h.answers['auth.probe'] = () => ({ ok: true, data: { supported: false, message: 'Not a Slack workspace' } });
      await expect(h.channels.connect({ providerId: 'ext-slack-bridge', token: 't' })).rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_INSTANCE', message: 'Not a Slack workspace' });
      h.answers['auth.probe'] = () => ({ ok: true, data: { supported: true } });
      // A 401 the service reports counts only when the proxy saw the server give it.
      h.answers['auth.verify'] = () => ({ ok: false, error: { message: 'invalid_auth', status: 401 } });
      await expect(h.channels.connect({ providerId: 'ext-slack-bridge', token: 't' })).rejects.toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
      const refusing = await harness({ server: async () => new Response('{"ok":false}', { status: 401 }) });
      try {
        refusing.answers['auth.verify'] = async (request) => {
          await refusing.handles.serve({ bearer: request.session.handle, body: { method: 'POST', path: '/api/auth.test' } });
          return { ok: false, error: { message: 'invalid_auth', status: 401 } };
        };
        await expect(refusing.channels.connect({ providerId: 'ext-slack-bridge', token: 'bad' })).rejects.toMatchObject({ status: 401, code: 'TOKEN_REFUSED' });
        expect(await refusing.accounts.read('ext-slack-bridge')).toBeNull();
      } finally { await refusing.cleanup(); }
      h.failProxyWith(Object.assign(new Error('not ready'), { code: 'SERVICE_FAILED' }));
      await expect(h.channels.connect({ providerId: 'ext-slack-bridge', token: 't' })).rejects.toMatchObject({ status: 503, code: 'CHANNEL_UNAVAILABLE' });
    } finally { await h.cleanup(); }
  });
});

describe('delivery', () => {
  test('rechecks enterprise mode after a notification waits behind another call', async () => {
    const previousMode = process.env.OPENCHAMBER_ENTERPRISE_MODE;
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'false';
    const h = await harness();
    const started = deferred();
    const gate = deferred();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'token' });
      h.calls.length = 0;
      h.answers.notify = async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, data: { delivered: true } };
      };
      const first = h.channels.deliver({ notification, requireHidden: false });
      await started.promise;
      const titles = {
        ready: 'Agent response is ready', error: 'Agent hit an error', question: 'Agent needs your input',
        permission: 'Agent needs permission', review: 'Review finished', goal_complete: 'Goal complete',
        goal_blocked: 'Goal blocked', goal_budget: 'Goal reached its token budget',
      };
      const waiting = Object.keys(titles).map((kind) => h.channels.deliver({ notification: { ...notification, kind }, requireHidden: false }));
      process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
      gate.resolve();
      await Promise.all([first, ...waiting]);
      expect(h.calls[0].request.input.notification).toEqual(notification);
      expect(h.calls.slice(1).map(({ request }) => request.input.notification)).toEqual(Object.entries(titles).map(([kind, title]) => ({
        ...notification, kind, title, body: '', sessionName: null, directory: null,
      })));
      expect(notification.body).toBe('The parser passes.');
    } finally {
      gate.resolve();
      await h.cleanup();
      if (previousMode === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      else process.env.OPENCHAMBER_ENTERPRISE_MODE = previousMode;
    }
  });

  test('bounds outstanding work and drains it in order without overlapping service calls', async () => {
    const h = await harness();
    const started = deferred();
    const gate = deferred();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'token' });
      h.calls.length = 0;
      let active = 0;
      let peak = 0;
      h.answers.notify = async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.resolve();
        await gate.promise;
        active -= 1;
        return { ok: true, data: { delivered: true } };
      };
      const first = h.channels.deliver({ notification: { ...notification, tag: '0' }, requireHidden: false });
      await started.promise;
      const pending = Array.from({ length: 204 }, (_, i) => h.channels.deliver({ notification: { ...notification, tag: String(i + 1) }, requireHidden: false }));
      gate.resolve();
      await Promise.all([first, ...pending]);
      expect(peak).toBe(1);
      expect(h.calls.map(({ request }) => request.input.notification.tag)).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toContain('CHANNEL_BUSY');
    } finally { gate.resolve(); await h.cleanup(); }
  });

  test('a delayed 401 for the previous account cannot invalidate its replacement', async () => {
    const h = await harness({ server: async () => new Response('', { status: 401 }) });
    const started = deferred();
    const gate = deferred();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'old' });
      h.answers.notify = async (request) => {
        await h.handles.serve({ bearer: request.session.handle, body: { method: 'POST', path: '/api/chat.postMessage' } });
        started.resolve();
        await gate.promise;
        return { ok: false, error: { message: 'invalid_auth', status: 401 } };
      };
      const delivering = h.channels.deliver({ notification, requireHidden: false });
      await started.promise;
      // A newer connection committed while the old service response was on the wire.
      await h.accounts.set('ext-slack-bridge', { instance: 'https://slack.com', token: 'new', account: { id: 'U1', login: 'mona' } });
      gate.resolve();
      await delivering;
      expect((await h.accounts.read('ext-slack-bridge')).account).toMatchObject({ token: 'new', status: 'valid' });
    } finally { gate.resolve(); await h.cleanup(); }
  });

  test('serializes calls per channel and cancels queued deliveries on pause', async () => {
    const h = await harness();
    const started = deferred();
    const gate = deferred();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'token' });
      h.calls.length = 0;
      let active = 0;
      let peak = 0;
      h.answers.notify = async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.resolve();
        await gate.promise;
        active -= 1;
        return { ok: true, data: { delivered: true } };
      };
      const first = h.channels.deliver({ notification, requireHidden: false });
      await started.promise;
      const second = h.channels.deliver({ notification, requireHidden: false });
      const third = h.channels.deliver({ notification, requireHidden: false });
      h.catalog[0] = channelGuest({ enabled: false });
      await h.channels.deactivated({ guestId: 'slack-bridge' });
      gate.resolve();
      await Promise.all([first, second, third]);
      expect(peak).toBe(1);
      expect(h.calls).toHaveLength(1);
      expect(h.warnings).toHaveLength(0);
    } finally { gate.resolve(); await h.cleanup(); }
  });

  test('sends to every connected channel with the push text, as the account, and never while a client is visible unless always', async () => {
    const h = await harness();
    try {
      await h.channels.deliver({ notification, requireHidden: true });
      expect(h.calls).toHaveLength(0);
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb' });
      h.calls.length = 0;
      await h.channels.deliver({ notification, requireHidden: true });
      expect(h.calls.map((call) => call.request.method)).toEqual(['notify']);
      const [call] = h.calls;
      expect(call.params).toMatchObject({ timeoutMs: 10_000, idleStopMs: 600_000, responseMax: 16_000 });
      expect(call.request).toMatchObject({ method: 'notify', session: { instance: 'https://slack.com', account: { id: 'U1', login: 'mona' } }, input: { notification } });
      expect(h.handles.refusal(call.request.session.handle)).toMatchObject({ status: 403 });

      const visible = await harness({ visible: true });
      try {
        await visible.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb' });
        visible.calls.length = 0;
        await visible.channels.deliver({ notification, requireHidden: true });
        expect(visible.calls).toHaveLength(0);
        await visible.channels.deliver({ notification, requireHidden: false });
        expect(visible.calls).toHaveLength(1);
      } finally { await visible.cleanup(); }
    } finally { await h.cleanup(); }
  });

  test('a token the server refused is written off once and the channel is skipped afterwards', async () => {
    const h = await harness({ server: async () => new Response('', { status: 401 }) });
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb' });
      h.calls.length = 0;
      h.answers.notify = async (request) => {
        await h.handles.serve({ bearer: request.session.handle, body: { method: 'POST', path: '/api/chat.postMessage' } });
        return { ok: false, error: { message: 'invalid_auth', status: 401 } };
      };
      await h.channels.deliver({ notification, requireHidden: false });
      expect((await h.accounts.publicView('ext-slack-bridge'))?.account.status).toBe('invalid');
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toContain('reconnect');
      expect(h.warnings[0]).not.toContain('parser');
      await h.channels.deliver({ notification, requireHidden: false });
      expect(h.calls).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test('a fixed channel whose server moved in an update is written off until the user connects again', async () => {
    const h = await harness();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb' });
      h.calls.length = 0;
      h.catalog[0] = channelGuest({ notifications: { ...slack, instances: { kind: 'fixed', origin: 'https://slack.example.com' } } });
      await h.channels.reconcile();
      expect((await h.accounts.publicView('ext-slack-bridge'))?.account).toMatchObject({ status: 'invalid', invalidReason: 'instance-changed' });
      await h.channels.deliver({ notification, requireHidden: false });
      expect(h.calls).toHaveLength(0);
      expect((await h.channels.list())[0].account?.account.status).toBe('invalid');
      // Connecting again binds the token to the server the manifest names now.
      const view = await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb-new' });
      expect(view).toMatchObject({ instance: 'https://slack.example.com', account: { status: 'valid' } });
    } finally { await h.cleanup(); }
  });

  test('a failing service warns once a minute without the text; a paused one is silent; a removed one loses its account', async () => {
    const h = await harness();
    try {
      await h.channels.connect({ providerId: 'ext-slack-bridge', token: 'xoxb' });
      h.calls.length = 0;
      h.answers.notify = () => ({ ok: false, error: { message: 'channel_not_found', status: 404 } });
      await h.channels.deliver({ notification, requireHidden: false });
      await h.channels.deliver({ notification, requireHidden: false });
      expect(h.calls).toHaveLength(2);
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toContain('channel_not_found');
      expect(h.warnings[0]).not.toContain('The parser passes');

      h.failProxyWith(Object.assign(new Error('paused'), { code: 'DISABLED' }));
      await h.channels.deliver({ notification, requireHidden: false });
      expect(h.warnings).toHaveLength(1);

      h.catalog.length = 0;
      await h.channels.deactivated({ guestId: 'slack-bridge', removed: true });
      expect(await h.channels.list()).toEqual([]);
      expect(await h.accounts.read('ext-slack-bridge')).toBeNull();
    } finally { await h.cleanup(); }
  });
});
