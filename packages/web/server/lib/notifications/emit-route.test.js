import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPluginNotificationEmitter, registerNotificationEmitRoutes } from './emit-route.js';
import { createNotificationTriggerRuntime } from './runtime.js';

const PLUGIN_TOKEN = 'Bearer plugin-token';
const UI_TOKEN = 'Bearer ui-token';

const createApp = ({ settings = { nativeNotificationsEnabled: true, notificationMode: 'hidden-only' }, now = () => 0 } = {}) => {
  const delivered = [];
  const pushed = [];
  const app = express();
  const emitter = createPluginNotificationEmitter({
    readSettingsFromDiskMigrated: async () => settings,
    emitDesktopNotification: () => false,
    broadcastUiNotification: (payload, options) => delivered.push({ payload, options }),
    pushPluginNotification: async (notice) => { pushed.push(notice); },
    now,
  });
  const routes = registerNotificationEmitRoutes(app, {
    express,
    isAgentToolRequestAuthorized: (req) => req.headers.authorization === PLUGIN_TOKEN,
    emitter,
  });
  routes.registerPluginRoute();
  // The route carries the server's API gate itself; nothing is mounted in front
  // of it here, so a missing gate would show up as an open endpoint.
  routes.registerApiRoute((req, res, next) => (
    req.headers.authorization === UI_TOKEN ? next() : res.status(401).json({ error: 'UI session missing' })
  ));
  return { app, delivered, pushed };
};

describe('POST /api/notifications/emit', () => {
  it('delivers a plugin notification without a UI session', async () => {
    const { app, delivered, pushed } = createApp();
    const response = await request(app)
      .post('/api/notifications/emit')
      .set('Authorization', PLUGIN_TOKEN)
      .send({ title: ' Build done ', body: 'Ready', sessionId: 'ses_1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: true });
    expect(delivered).toEqual([{
      payload: {
        title: 'Build done',
        body: 'Ready',
        tag: undefined,
        kind: 'plugin',
        sessionId: 'ses_1',
        directory: undefined,
        requireHidden: true,
        showWhenFocused: false,
      },
      options: { desktopNotificationDelivered: false },
    }]);
    expect(pushed).toEqual([delivered[0].payload]);
  });

  it('accepts an ordinary API caller and rejects an unauthenticated one', async () => {
    const { app, delivered } = createApp();
    await request(app).post('/api/notifications/emit').set('Authorization', UI_TOKEN).send({ body: 'Hi' }).expect(200);
    await request(app).post('/api/notifications/emit').send({ body: 'Hi' }).expect(401);
    await request(app).post('/api/notifications/emit').set('Authorization', 'Bearer wrong').send({ body: 'Hi' }).expect(401);
    expect(delivered.map(({ payload }) => payload.title)).toEqual(['OpenChamber']);
  });

  it('refuses to register the API route without a gate', () => {
    const app = express();
    const routes = registerNotificationEmitRoutes(app, {
      express,
      isAgentToolRequestAuthorized: () => false,
      emitter: { emit: async () => ({ status: 200, body: {} }) },
    });

    expect(() => routes.registerApiRoute()).toThrow(TypeError);
  });

  it('never lets a caller choose the notification kind', async () => {
    const { app, delivered } = createApp();
    await request(app)
      .post('/api/notifications/emit')
      .set('Authorization', PLUGIN_TOKEN)
      .send({ title: 'x', kind: 'opencode-restart-interrupted' })
      .expect(200);
    expect(delivered[0].payload.kind).toBe('plugin');
  });

  it('rejects empty and oversized payloads', async () => {
    const { app, delivered, pushed } = createApp();
    const post = (body) => request(app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send(body);
    await post({}).expect(400);
    await post({ title: '   ' }).expect(400);
    await post({ title: 'x'.repeat(121) }).expect(400);
    await post({ body: 'x'.repeat(501) }).expect(400);
    expect(delivered).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('limits the rate and recovers after the window', async () => {
    let clock = 0;
    const { app, delivered, pushed } = createApp({ now: () => clock });
    const post = () => request(app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'tick' });
    for (let index = 0; index < 10; index += 1) await post().expect(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('10');
    clock = 10_000;
    await post().expect(200);
    expect(delivered).toHaveLength(11);
    expect(pushed).toHaveLength(11);
  });

  it('follows the notifications setting and the always mode', async () => {
    const off = createApp({ settings: { nativeNotificationsEnabled: false } });
    const skipped = await request(off.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x' });
    expect(skipped.body).toEqual({ delivered: false, reason: 'notifications-disabled' });
    expect(off.delivered).toEqual([]);
    // The switch covers pop-ups in open windows only; push follows the subscription.
    expect(off.pushed).toEqual([expect.objectContaining({ title: 'OpenChamber', body: 'x', kind: 'plugin' })]);

    const always = createApp({ settings: { nativeNotificationsEnabled: true, notificationMode: 'always' } });
    await request(always.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x' }).expect(200);
    expect(always.delivered[0].payload.requireHidden).toBe(true);
    expect(always.delivered[0].payload.showWhenFocused).toBe(true);

    const focused = createApp();
    await request(focused.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x', showWhenFocused: true }).expect(200);
    expect(focused.delivered[0].payload.requireHidden).toBe(true);
    expect(focused.delivered[0].payload.showWhenFocused).toBe(true);
    await request(focused.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x', showWhenFocused: 'yes' }).expect(400);
  });
});

describe('plugin notifications on devices away from OpenChamber', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const sessionIdOf = (url) => decodeURIComponent(String(url).split('/session/')[1]?.split(/[?/]/)[0] ?? '');
  const knownSession = async (url) => Response.json({ id: sessionIdOf(url), title: 'Release check' });
  const createRuntime = ({ notificationMode = 'hidden-only', windowFocused = false, fetchImpl = knownSession, openPushTagsStore } = {}) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const webPush = vi.fn();
    const apns = vi.fn();
    const clearApns = vi.fn();
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode }),
      emitDesktopNotification: () => false,
      broadcastUiNotification: () => {},
      sendPushToAllUiSessions: webPush,
      sendApnsToAllUiSessions: apns,
      clearApnsNotifications: clearApns,
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      getIsWindowFocused: () => windowFocused,
      openPushTagsStore,
    });
    return { runtime, clearApns, apnsMock: apns, webPushMock: webPush };
  };
  const pushThroughRuntime = async (notice, options) => {
    const created = createRuntime(options);
    await created.runtime.pushPluginNotification(notice);
    return { ...created, webPush: created.webPushMock.mock.calls[0]?.[0], apns: created.apnsMock.mock.calls[0]?.[0] };
  };
  const clearEntryOf = ([payload]) => `${payload.tag}@${payload.data.nid}`;

  it('pushes the text with the session to open, under a tag that hides the caller\'s', async () => {
    const { webPush, apns } = await pushThroughRuntime({ title: 'Release is out', body: 'v2.0.0', tag: 'release-acme', sessionId: 'ses_1' });
    expect(webPush).toMatchObject({
      title: 'Release is out',
      body: 'v2.0.0',
      data: { url: '/?session=ses_1', sessionId: 'ses_1', sessionName: 'Release check', type: 'plugin' },
    });
    expect(apns).toMatchObject({ body: 'Release check', sealed: { title: 'Release check', body: 'Release is out: v2.0.0' } });
    expect(webPush.tag).toMatch(/^plugin-[0-9a-f]{16}$/);
    expect(apns.tag).toBe(webPush.tag);
  });

  it('stays on the phone through the session\'s next turn and clears once the user answers in it', async () => {
    const { runtime, clearApns, apnsMock } = await pushThroughRuntime({ title: 'Release is out', sessionId: 'ses_1' });
    await runtime.maybeSendPushForTrigger({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' }, turnStartedAt: 2 } });
    expect(clearApns).not.toHaveBeenCalled();
    await runtime.clearSessionPushNotifications('ses_1');
    expect(clearApns).toHaveBeenCalledWith(expect.objectContaining({ tags: apnsMock.mock.calls.map(clearEntryOf) }));
  });

  it('stacks a session\'s notifications and clears the newest 10 everywhere when the session is opened', async () => {
    const { runtime, clearApns, apnsMock, webPushMock } = await pushThroughRuntime({ title: 'Note 0', sessionId: 'ses_1' });
    for (let n = 1; n <= 10; n += 1) await runtime.pushPluginNotification({ title: `Note ${n}`, sessionId: 'ses_1' });
    await runtime.sendGoalSettlePush({ sessionId: 'ses_1', status: 'complete', title: 'Goal', body: 'done' });
    const sent = apnsMock.mock.calls.map(clearEntryOf);
    expect(new Set(sent.map((entry) => entry.split('@')[0])).size).toBe(12);
    await runtime.clearSessionPushNotifications('ses_1');
    expect(clearApns.mock.calls[0][0].tags).toEqual(sent.slice(1));
    await runtime.pushPluginNotification({ title: 'Other', sessionId: 'ses_2' });
    expect(webPushMock.mock.calls.at(-1)[0].clear).toEqual(sent.slice(1));
  });

  it('keeps the cap when a caller tag moves a claim in from another session', async () => {
    const { runtime, clearApns, apnsMock } = await pushThroughRuntime({ title: 'Deploy', tag: 'deploy', sessionId: 'ses_2' });
    for (let n = 1; n <= 10; n += 1) await runtime.pushPluginNotification({ title: `Note ${n}`, sessionId: 'ses_1' });
    await runtime.pushPluginNotification({ title: 'Deploy', tag: 'deploy', sessionId: 'ses_1' });
    const sent = apnsMock.mock.calls.map(clearEntryOf);
    await runtime.clearSessionPushNotifications('ses_1');
    expect(clearApns.mock.calls[0][0].tags).toEqual(sent.slice(2));
  });

  it('never trims a notice that is still waiting to go out', async () => {
    let releaseFirst;
    const { runtime, apnsMock } = createRuntime({
      fetchImpl: async (url) => {
        if (!releaseFirst) await new Promise((resolve) => { releaseFirst = resolve; });
        return knownSession(url);
      },
    });
    const first = runtime.pushPluginNotification({ title: 'First', sessionId: 'ses_1' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    for (let n = 1; n <= 10; n += 1) await runtime.pushPluginNotification({ title: `Note ${n}`, sessionId: 'ses_1' });
    releaseFirst();
    await first;
    expect(apnsMock.mock.calls.map(([payload]) => payload.sealed?.body)).toContain('First');
  });

  it('shows no session name on a phone for a notification without a session', async () => {
    const { apns } = await pushThroughRuntime({ title: 'Release is out', body: 'v2.0.0' });
    expect(apns).toMatchObject({ title: 'Agent update', body: '', sealed: { title: 'Agent update', body: 'Release is out: v2.0.0' } });
  });

  it('keeps the text out of push in enterprise mode', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const { webPush, apns } = await pushThroughRuntime({ title: 'Release is out', body: 'v2.0.0', sessionId: 'ses_1' });
    expect(webPush).toMatchObject({ title: 'Agent update', body: '' });
    expect(webPush.data.sessionName).toBeUndefined();
    expect(apns).toMatchObject({ title: 'Agent update', body: '' });
    expect(apns.sealed).toBeUndefined();
  });

  it('sends a session OpenCode does not know as a generic notice, in enterprise mode too', async () => {
    const missing = async () => new Response('not found', { status: 404 });
    for (const enterprise of [false, true]) {
      if (enterprise) vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
      const { runtime, webPush, apns, clearApns } = await pushThroughRuntime({ title: 'Release is out', tag: 'deploy', sessionId: 'ses_forged' }, { fetchImpl: missing });
      expect(webPush.data).toMatchObject({ url: '/', type: 'plugin' });
      expect(webPush.data.sessionId).toBeUndefined();
      expect(JSON.stringify(webPush)).not.toContain('ses_forged');
      expect(apns.data.sessionId).toBeUndefined();
      expect(JSON.stringify(apns)).not.toContain('ses_forged');
      expect(apns.body).toBe('');
      await runtime.clearSessionPushNotifications('ses_forged');
      expect(clearApns).not.toHaveBeenCalled();
    }
  });

  it('attaches no session when OpenCode answers without the session asked for', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    for (const answer of [{}, { id: 'ses_other', title: 'Other' }]) {
      const { runtime, webPush, apns, clearApns } = await pushThroughRuntime({ title: 'Release is out', sessionId: 'ses_forged' }, { fetchImpl: async () => Response.json(answer) });
      expect(webPush.data).toMatchObject({ url: '/', type: 'plugin' });
      expect(JSON.stringify(webPush)).not.toContain('ses_forged');
      expect(JSON.stringify(apns)).not.toContain('ses_forged');
      await runtime.clearSessionPushNotifications('ses_forged');
      expect(clearApns).not.toHaveBeenCalled();
    }
  });

  const storeWith = (open) => ({ read: async () => ({ open, cleared: [] }), write: async () => {} });
  const ordinaryClaims = (count) => Array.from({ length: count }, (_, n) => [`ready-ses_${n}`, { sessionId: `ses_${n}`, nid: '1', native: true }]);

  it('lets only one of two notices sent together take the last free slot', async () => {
    const { runtime, clearApns, apnsMock } = createRuntime({ openPushTagsStore: storeWith(ordinaryClaims(499)) });
    await Promise.all([
      runtime.pushPluginNotification({ title: 'A', sessionId: 'ses_a' }),
      runtime.pushPluginNotification({ title: 'B', sessionId: 'ses_b' }),
    ]);
    expect(apnsMock).toHaveBeenCalledTimes(2);
    await runtime.clearSessionPushNotifications('ses_0');
    expect(clearApns.mock.calls[0][0].tags).toEqual(['ready-ses_0@1']);
  });

  it('keeps an open notice when a notice for an unknown session arrives into a full store', async () => {
    const { runtime, clearApns, apnsMock } = createRuntime({
      openPushTagsStore: storeWith(ordinaryClaims(499)),
      fetchImpl: async (url) => sessionIdOf(url) === 'ses_forged' ? new Response('not found', { status: 404 }) : knownSession(url),
    });
    await runtime.pushPluginNotification({ title: 'Kept', sessionId: 'ses_kept' });
    await runtime.pushPluginNotification({ title: 'Forged', sessionId: 'ses_forged' });
    expect(apnsMock).toHaveBeenCalledTimes(2);
    await runtime.clearSessionPushNotifications('ses_kept');
    expect(clearApns.mock.calls[0][0].tags).toEqual([clearEntryOf(apnsMock.mock.calls[0])]);
  });

  it('detaches a saved claim that a sessionless notice replaces while the store is still loading', async () => {
    const { runtime: first, apnsMock: firstApns } = createRuntime();
    await first.pushPluginNotification({ title: 'Deploy started', tag: 'deploy', sessionId: 'ses_1' });
    const [started] = firstApns.mock.calls[0];
    let finishRestore;
    const { runtime, clearApns } = createRuntime({
      openPushTagsStore: {
        read: () => new Promise((resolve) => {
          finishRestore = () => resolve({ open: [[started.tag, { sessionId: 'ses_1', nid: started.data.nid, native: true }]], cleared: [] });
        }),
        write: async () => {},
      },
    });
    const replacement = runtime.pushPluginNotification({ title: 'Deploy done', tag: 'deploy' });
    await vi.waitFor(() => expect(finishRestore).toBeTypeOf('function'));
    finishRestore();
    await replacement;
    await runtime.clearSessionPushNotifications('ses_1');
    expect(clearApns).not.toHaveBeenCalled();
  });

  it('detaches a tag a sessionless notice took over, and gives that notice an id a late clear cannot reach', async () => {
    const { runtime, clearApns, apnsMock, webPushMock } = await pushThroughRuntime({ title: 'Deploy started', tag: 'deploy', sessionId: 'ses_1' });
    const [sessionWeb] = webPushMock.mock.calls[0];
    await runtime.pushPluginNotification({ title: 'Deploy done', tag: 'deploy' });
    const [web] = webPushMock.mock.calls[1];
    const [native] = apnsMock.mock.calls[1];
    expect(web.tag).toBe(sessionWeb.tag);
    expect(Number(web.data.nid)).toBeGreaterThan(Number(sessionWeb.data.nid));
    expect(native.data.nid).toBe(web.data.nid);
    await runtime.clearSessionPushNotifications('ses_1');
    expect(clearApns).not.toHaveBeenCalled();
    await runtime.pushPluginNotification({ title: 'Other', sessionId: 'ses_2' });
    expect(webPushMock.mock.calls.at(-1)[0].clear ?? []).not.toContainEqual(expect.stringContaining(web.tag));
  });

  it('never evicts other kinds\' claims from a full store', async () => {
    const open = Array.from({ length: 500 }, (_, n) => [`ready-ses_${n}`, { sessionId: `ses_${n}`, nid: '1', native: true }]);
    const { runtime, clearApns, apnsMock } = createRuntime({
      openPushTagsStore: { read: async () => ({ open, cleared: [] }), write: async () => {} },
    });
    for (let n = 0; n < 11; n += 1) await runtime.pushPluginNotification({ title: `Note ${n}`, sessionId: 'ses_busy' });
    expect(apnsMock).toHaveBeenCalledTimes(11);
    for (const [, nativeCall] of apnsMock.mock.calls.entries()) expect(nativeCall[0].data.nid).toBeTruthy();
    await runtime.clearSessionPushNotifications('ses_0');
    expect(clearApns.mock.calls[0][0].tags).toEqual(['ready-ses_0@1']);
  });

  it('keeps a child\'s clear for other browsers when the parent is opened after many plugin notices', async () => {
    const { runtime, webPushMock } = createRuntime({
      fetchImpl: async (url) => {
        const id = sessionIdOf(url);
        return Response.json({ id, title: 'Child', parentID: id === 'ses_a' || id === 'ses_b' ? 'ses_parent' : undefined });
      },
    });
    await runtime.sendGoalSettlePush({ sessionId: 'ses_a', status: 'complete', title: 'Goal', body: 'done' });
    const goalEntry = `${webPushMock.mock.calls[0][0].tag}@${webPushMock.mock.calls[0][0].data.nid}`;
    for (const child of ['ses_a', 'ses_b']) {
      for (let n = 0; n < 10; n += 1) await runtime.pushPluginNotification({ title: `Note ${n}`, sessionId: child });
    }
    await runtime.clearSessionPushNotifications('ses_parent', { viewed: true });
    await runtime.pushPluginNotification({ title: 'Elsewhere', sessionId: 'ses_other' });
    const clear = webPushMock.mock.calls.at(-1)[0].clear;
    expect(clear).toContain(goalEntry);
    expect(clear.filter((entry) => entry.startsWith('plugin-'))).toHaveLength(10);
  });

  it('pushes nothing while the desktop window is focused, unless notifications show in focus', async () => {
    const focused = await pushThroughRuntime({ title: 'Release is out' }, { windowFocused: true });
    expect([focused.webPush, focused.apns]).toEqual([undefined, undefined]);
    const always = await pushThroughRuntime({ title: 'Release is out' }, { windowFocused: true, notificationMode: 'always' });
    expect(always.apns).toMatchObject({ sealed: { body: 'Release is out' } });
  });
});
