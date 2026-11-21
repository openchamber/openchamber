import { hasErrorMessage, isJsonObject, isString } from './inputs.js';
import type { JsonValue, PushSettings, SseWriter } from './contracts.js';
import type { createPushRuntime } from './push-runtime.js';
import type { createSessionRuntime } from '../opencode/session-runtime.js';
import type { IncomingHttpHeaders } from 'node:http';

interface NotificationRequest {
  body?: JsonValue;
  params: { id: string };
  headers: IncomingHttpHeaders;
  on: (event: 'close', listener: () => void) => void;
}

interface NotificationResponse extends SseWriter {
  setHeader: (name: string, value: string) => void;
  status: (status: number) => NotificationResponse;
  json: <Body>(body: Body) => void;
  on: (event: 'error', listener: () => void) => void;
  flushHeaders?: () => void;
  flush?: () => void;
  writableEnded: boolean;
  destroyed: boolean;
}

type NotificationRouteHandler = (req: NotificationRequest, res: NotificationResponse) => void | Promise<void>;
type SessionRuntime = ReturnType<typeof createSessionRuntime>;
type PushRuntime = ReturnType<typeof createPushRuntime>;

interface NotificationRouteDependencies extends Pick<PushRuntime,
  'ensurePushInitialized' | 'getOrCreateVapidKeys' | 'addOrUpdatePushSubscription' | 'removePushSubscription' |
  'updateUiVisibility' | 'isUiVisible' | 'setPushInitialized'>, Pick<SessionRuntime,
  'getSessionActivitySnapshot' | 'getSessionStateSnapshot' | 'getSessionState'> {
  uiAuthController?: { ensureSessionToken?: (req: NotificationRequest, res: NotificationResponse) => string | null | Promise<string | null> };
  ensureGlobalWatcherStarted?: () => Promise<void>;
  getUiSessionTokenFromRequest: (req: NotificationRequest) => string | null;
  readSettingsFromDiskMigrated: () => Promise<PushSettings>;
  writeSettingsToDisk: (settings: PushSettings) => Promise<void>;
  addOrUpdateApnsToken?: (token: string, deviceToken: string, userAgent: string | undefined, platform: string, environment: string, pushKey: JsonValue | undefined) => Promise<void>;
  removeApnsToken?: (token: string, deviceToken: string) => Promise<void>;
  clearPendingPushBadge?: () => void;
  clearSessionPushNotifications?: (sessionId: string, options?: { viewed?: boolean }) => Promise<void>;
  getUiNotificationClients: () => Set<NotificationResponse>;
  writeSseEvent: (res: SseWriter, payload: { type: string; properties: { uiToken: string } }) => void;
  getPendingBlockingRequestsSnapshot?: SessionRuntime['getPendingBlockingRequestsSnapshot'];
  getSessionContextSnapshot?: SessionRuntime['getSessionContextSnapshot'];
  setAutoAcceptSession?: (sessionId: string, enabled: boolean) => void;
  isLocalOnlyPushRequest: (req: NotificationRequest, uiToken: string) => Promise<boolean>;
}

const parsePushSubscribeBody = (body: JsonValue | undefined) => {
  if (!isJsonObject(body)) return null;
  const endpoint = body.endpoint;
  const keys = body.keys;
  const p256dh = isJsonObject(keys) ? keys.p256dh : undefined;
  const auth = isJsonObject(keys) ? keys.auth : undefined;

  if (!isString(endpoint) || endpoint.trim().length === 0) return null;
  if (!isString(p256dh) || p256dh.trim().length === 0) return null;
  if (!isString(auth) || auth.trim().length === 0) return null;

  return {
    endpoint: endpoint.trim(),
    keys: { p256dh: p256dh.trim(), auth: auth.trim() },
  };
};

const parsePushUnsubscribeBody = (body: JsonValue | undefined) => {
  if (!isJsonObject(body)) return null;
  const endpoint = body.endpoint;
  if (!isString(endpoint) || endpoint.trim().length === 0) return null;
  return { endpoint: endpoint.trim() };
};

export const NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export const registerNotificationRoutes = (app: {
  get: (route: string, handler: NotificationRouteHandler) => void;
  post: (route: string, handler: NotificationRouteHandler) => void;
  delete: (route: string, handler: NotificationRouteHandler) => void;
}, dependencies: NotificationRouteDependencies) => {
  const {
    uiAuthController,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge,
    clearSessionPushNotifications,
    isUiVisible,
    getUiNotificationClients,
    writeSseEvent,
    getSessionActivitySnapshot,
    getSessionStateSnapshot,
    getPendingBlockingRequestsSnapshot,
    getSessionContextSnapshot,
    getSessionState,
    setPushInitialized,
    setAutoAcceptSession,
    isLocalOnlyPushRequest,
  } = dependencies;

  const ensureSessionWatcher = async () => {
    if (!ensureGlobalWatcherStarted) {
      return;
    }
    try {
      await ensureGlobalWatcherStarted();
    } catch (error) {
      console.warn('[OpenCodeWatcher] lazy start failed:', hasErrorMessage(error) ? error.message ?? error : error);
    }
  };

  const rememberPublicOrigin = async (origin: string) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      if (!isString(settings?.publicOrigin) || settings.publicOrigin.trim().length === 0) {
        await writeSettingsToDisk({ ...settings, publicOrigin: origin });
        setPushInitialized(false);
      }
    } catch {
      return;
    }
  };

  app.get('/api/push/vapid-public-key', async (_req, res) => {
    try {
      await ensurePushInitialized();
      const keys = await getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (error) {
      console.warn('[Push] Failed to load VAPID key:', error);
      res.status(500).json({ error: 'Failed to load push key' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();
    await ensureSessionWatcher();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushSubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const { endpoint, keys } = parsed;

    const body = isJsonObject(req.body) ? req.body : {};
    const origin = isString(body.origin) ? body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      await rememberPublicOrigin(origin);
    }

    const platform = isString(body.platform) ? body.platform : undefined;
    await addOrUpdatePushSubscription(
      uiToken,
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      req.headers['user-agent'],
      platform
    );

    return res.json({ ok: true });
  });

  app.delete('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushUnsubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    await removePushSubscription(uiToken, parsed.endpoint);
    return res.json({ ok: true });
  });

  app.post('/api/push/apns-token', async (req, res) => {
    await ensureSessionWatcher();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = isJsonObject(req.body) ? req.body : {};
    const deviceToken = isString(body.token) ? body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (await isLocalOnlyPushRequest(req, uiToken)) {
      return res.json({ ok: true, localOnly: true });
    }

    const platform = body.platform === 'android' ? 'android' : 'ios';
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production';
    if (addOrUpdateApnsToken) {
      await addOrUpdateApnsToken(uiToken, deviceToken, req.headers['user-agent'], platform, environment, body.pushKey);
    }
    return res.json({ ok: true });
  });

  app.get('/api/push/delivery', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ localOnly: await isLocalOnlyPushRequest(req, uiToken) });
  });

  app.delete('/api/push/apns-token', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = isJsonObject(req.body) ? req.body : {};
    const deviceToken = isString(body.token) ? body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (removeApnsToken) {
      await removeApnsToken(uiToken, deviceToken);
    }
    return res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = isJsonObject(req.body) ? req.body : {};
    const platform = isString(body.platform) ? body.platform : undefined;
    updateUiVisibility(uiToken, body.visible === true, platform);
    return res.json({ ok: true });
  });

  app.get('/api/push/visibility', (req, res) => {
    const uiToken = getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    return res.json({
      ok: true,
      visible: isUiVisible(uiToken),
    });
  });

  app.get('/api/notifications/stream', async (req, res) => {
    await ensureSessionWatcher();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getUiNotificationClients();
    clients.add(res);

    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      clients.delete(res);
    };

    req.on('close', cleanup);
    res.on('error', cleanup);

    const flushSse = () => {
      res.flush?.();
    };

    heartbeatTimer = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try {
        res.write(':heartbeat\n\n');
        flushSse();
      } catch {
        cleanup();
      }
    }, NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);

    try {
      writeSseEvent(res, {
        type: 'openchamber:notification-stream-ready',
        properties: { uiToken },
      });
      flushSse();
    } catch {
      cleanup();
    }
  });

  app.get('/api/session-activity', (_req, res) => {
    void ensureSessionWatcher();
    res.json(getSessionActivitySnapshot());
  });

  app.get('/api/sessions/snapshot', async (_req, res) => {
    await ensureSessionWatcher();
    res.json({
      statusSessions: getSessionStateSnapshot(),
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/status', async (_req, res) => {
    await ensureSessionWatcher();
    const snapshot = getSessionStateSnapshot();
    res.json({
      sessions: snapshot,
      pending: getPendingBlockingRequestsSnapshot ? getPendingBlockingRequestsSnapshot() : {},
      context: getSessionContextSnapshot ? getSessionContextSnapshot() : {},
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/:id/status', async (req, res) => {
    await ensureSessionWatcher();
    const sessionId = req.params.id;
    const state = getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no state available',
        sessionId,
      });
    }

    return res.json({
      sessionId,
      ...state,
    });
  });

  app.post('/api/sessions/:id/view', (req, res) => {
    const sessionId = req.params.id;
    if (clearPendingPushBadge) clearPendingPushBadge();
    void clearSessionPushNotifications?.(sessionId, { viewed: true });

    return res.json({
      success: true,
      sessionId,
      viewed: true,
    });
  });

  app.post('/api/sessions/:id/message-sent', (req, res) => {
    const sessionId = req.params.id;
    if (clearPendingPushBadge) clearPendingPushBadge();
    void clearSessionPushNotifications?.(sessionId);

    return res.json({
      success: true,
      sessionId,
      messageSent: true,
    });
  });

  app.post('/api/notifications/auto-accept', (req, res) => {
    const body = isJsonObject(req.body) ? req.body : {};
    const sessionId = isString(body.sessionId) ? body.sessionId.trim() : '';
    const enabled = body.enabled === true;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    if (setAutoAcceptSession) {
      setAutoAcceptSession(sessionId, enabled);
    }
    return res.json({ success: true, sessionId, enabled });
  });
};
