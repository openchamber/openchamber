import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPluginNotificationEmitter, registerNotificationEmitRoutes } from './emit-route.js';

const PLUGIN_TOKEN = 'Bearer plugin-token';
const UI_TOKEN = 'Bearer ui-token';

const createApp = ({ settings = { nativeNotificationsEnabled: true, notificationMode: 'hidden-only' }, now = () => 0 } = {}) => {
  const delivered = [];
  const app = express();
  const emitter = createPluginNotificationEmitter({
    readSettingsFromDiskMigrated: async () => settings,
    emitDesktopNotification: () => false,
    broadcastUiNotification: (payload, options) => delivered.push({ payload, options }),
    now,
  });
  const routes = registerNotificationEmitRoutes(app, {
    express,
    isAgentToolRequestAuthorized: (req) => req.headers.authorization === PLUGIN_TOKEN,
    emitter,
  });
  routes.registerPluginRoute();
  // Stands in for the server's API auth gate between the two registrations.
  app.use('/api', (req, res, next) => (
    req.headers.authorization === UI_TOKEN ? next() : res.status(401).json({ error: 'UI session missing' })
  ));
  routes.registerApiRoute();
  return { app, delivered };
};

describe('POST /api/notifications/emit', () => {
  it('delivers a plugin notification without a UI session', async () => {
    const { app, delivered } = createApp();
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
      },
      options: { desktopNotificationDelivered: false },
    }]);
  });

  it('accepts an ordinary API caller and rejects an unauthenticated one', async () => {
    const { app, delivered } = createApp();
    await request(app).post('/api/notifications/emit').set('Authorization', UI_TOKEN).send({ body: 'Hi' }).expect(200);
    await request(app).post('/api/notifications/emit').send({ body: 'Hi' }).expect(401);
    await request(app).post('/api/notifications/emit').set('Authorization', 'Bearer wrong').send({ body: 'Hi' }).expect(401);
    expect(delivered.map(({ payload }) => payload.title)).toEqual(['OpenChamber']);
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
    const { app, delivered } = createApp();
    const post = (body) => request(app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send(body);
    await post({}).expect(400);
    await post({ title: '   ' }).expect(400);
    await post({ title: 'x'.repeat(121) }).expect(400);
    await post({ body: 'x'.repeat(501) }).expect(400);
    expect(delivered).toEqual([]);
  });

  it('limits the rate and recovers after the window', async () => {
    let clock = 0;
    const { app, delivered } = createApp({ now: () => clock });
    const post = () => request(app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'tick' });
    for (let index = 0; index < 10; index += 1) await post().expect(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('10');
    clock = 10_000;
    await post().expect(200);
    expect(delivered).toHaveLength(11);
  });

  it('follows the notifications setting and the always mode', async () => {
    const off = createApp({ settings: { nativeNotificationsEnabled: false } });
    const skipped = await request(off.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x' });
    expect(skipped.body).toEqual({ delivered: false, reason: 'notifications-disabled' });
    expect(off.delivered).toEqual([]);

    const always = createApp({ settings: { nativeNotificationsEnabled: true, notificationMode: 'always' } });
    await request(always.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x' }).expect(200);
    expect(always.delivered[0].payload.requireHidden).toBe(false);

    const focused = createApp();
    await request(focused.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x', showWhenFocused: true }).expect(200);
    expect(focused.delivered[0].payload.requireHidden).toBe(false);
    await request(focused.app).post('/api/notifications/emit').set('Authorization', PLUGIN_TOKEN).send({ body: 'x', showWhenFocused: 'yes' }).expect(400);
  });
});
