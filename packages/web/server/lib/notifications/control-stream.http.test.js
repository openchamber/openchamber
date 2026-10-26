import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createNotificationEmitterRuntime } from './emitter-runtime.js';

// Exercise the existing browser URL-token gate and the real SSE route, not an
// unauthenticated mock endpoint. Notification consolidation adds no auth bypass.
describe('notifications over the authenticated control stream', () => {
  it('rejects anonymous readers and delivers to a scoped authenticated stream', async () => {
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'test-client' ? { ok: true, clientId: 'fixture' } : null,
      },
    });
    const clients = new Set();
    const emitter = createNotificationEmitterRuntime({
      process,
      getDesktopNotifyEnabled: () => false,
      desktopNotifyPrefix: '',
      getUiNotificationClients: () => new Set(),
      getOpenChamberEventClients: () => clients,
    });
    const app = express();
    app.use(express.json());
    app.post('/auth/url-token', auth.handleUrlAuthToken);
    app.use('/api', auth.requireAuth);
    registerScheduledTaskRoutes(app, {
      getOpenChamberEventClients: () => clients,
      writeSseEvent: emitter.writeSseEvent,
    });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const abort = new AbortController();
    try {
      const denied = await fetch(`${base}/api/openchamber/events`);
      expect(denied.status).toBe(401);
      expect(clients.size).toBe(0);
      const tokenResponse = await fetch(`${base}/auth/url-token`, {
        method: 'POST', headers: { Authorization: 'Bearer test-client' },
      });
      expect(tokenResponse.status).toBe(200);
      const { token } = await tokenResponse.json();
      expect(token).toBeTruthy();
      const response = await fetch(`${base}/api/openchamber/events?browser=1&oc_url_token=${encodeURIComponent(token)}`, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body.getReader();
      const ready = new TextDecoder().decode((await reader.read()).value);
      expect(ready).toContain('openchamber:event-stream-ready');
      expect(clients.size).toBe(1);
      expect([...clients][0].openchamberBrowserCapable).toBe(true);
      emitter.broadcastUiNotification({ title: 'Done', sessionId: 's1', kind: 'complete' });
      const notification = new TextDecoder().decode((await reader.read()).value);
      expect(notification).toContain('"type":"openchamber:notification"');
      expect(notification).toContain('"sessionId":"s1"');
      await reader.cancel();
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      auth.dispose();
    }
  });
});
