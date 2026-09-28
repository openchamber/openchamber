import { z } from 'zod';

const NOTIFICATION_EMIT_PATH = '/api/notifications/emit';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_PER_WINDOW = 10;

const optionalText = (max) => z.string().trim().min(1).max(max).optional();

const emitBodySchema = z.object({
  title: optionalText(120),
  body: optionalText(500),
  tag: optionalText(128),
  sessionId: optionalText(128),
  directory: optionalText(4096),
  // Opt-in for notices that matter even while OpenChamber is in front.
  showWhenFocused: z.boolean().optional(),
}).refine((value) => value.title || value.body, { message: 'title or body required' });

/**
 * Raises a notification on behalf of a plugin or the agent, through the same
 * live delivery the built-in triggers use. `kind` is always `plugin`, so a
 * caller cannot impersonate kinds the UI treats specially. One rate window is
 * shared by every caller, the HTTP route and the agent tool alike.
 *
 * `emit` resolves to `{ status, body }`: 200 delivered or skipped by settings,
 * 400 invalid input, 429 rate limited (with `retryAfter` seconds).
 */
export const createPluginNotificationEmitter = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    emitDesktopNotification,
    broadcastUiNotification,
    now = Date.now,
  } = dependencies;

  let windowStartedAt = 0;
  let windowCount = 0;

  const takeRateSlot = () => {
    const current = now();
    if (current - windowStartedAt >= RATE_WINDOW_MS) {
      windowStartedAt = current;
      windowCount = 0;
    }
    if (windowCount >= RATE_MAX_PER_WINDOW) {
      return Math.ceil((windowStartedAt + RATE_WINDOW_MS - current) / 1000);
    }
    windowCount += 1;
    return 0;
  };

  const emit = async (input) => {
    const parsed = emitBodySchema.safeParse(input);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.issues[0]?.message ?? 'invalid notification' } };
    }

    const retryAfter = takeRateSlot();
    if (retryAfter > 0) {
      return { status: 429, retryAfter, body: { error: 'too many notifications' } };
    }

    const settings = await readSettingsFromDiskMigrated();
    if (settings.nativeNotificationsEnabled === false) {
      return { status: 200, body: { delivered: false, reason: 'notifications-disabled' } };
    }

    const payload = {
      title: parsed.data.title ?? 'OpenChamber',
      body: parsed.data.body,
      tag: parsed.data.tag,
      kind: 'plugin',
      sessionId: parsed.data.sessionId,
      directory: parsed.data.directory,
      requireHidden: parsed.data.showWhenFocused !== true && settings.notificationMode !== 'always',
    };
    const desktopNotificationDelivered = emitDesktopNotification(payload) === true;
    broadcastUiNotification(payload, { desktopNotificationDelivered });
    return { status: 200, body: { delivered: true } };
  };

  return { emit };
};

/**
 * `POST /api/notifications/emit`. Two callers are accepted: a plugin inside
 * the managed OpenCode (the agent-tool bearer token, checked before API auth)
 * and any client that passes the regular API auth.
 */
export const registerNotificationEmitRoutes = (app, dependencies) => {
  const { express, isAgentToolRequestAuthorized, emitter } = dependencies;

  const jsonBody = express.json({ limit: '16kb' });

  const respond = async (req, res, next) => {
    try {
      const result = await emitter.emit(req.body);
      if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(result.status).json(result.body);
    } catch (error) {
      return next(error);
    }
  };

  return {
    // Registered before API auth: a managed plugin carries no UI session.
    registerPluginRoute: () => {
      app.post(NOTIFICATION_EMIT_PATH, jsonBody, (req, res, next) => (
        isAgentToolRequestAuthorized(req) ? respond(req, res, next) : next()
      ));
    },
    // Registered after API auth: everything else is an ordinary API caller.
    registerApiRoute: () => {
      app.post(NOTIFICATION_EMIT_PATH, jsonBody, respond);
    },
  };
};
