import { z } from 'zod';
import type { NotificationPayload } from './contracts.js';

const NOTIFICATION_EMIT_PATH = '/api/notifications/emit';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_PER_WINDOW = 10;

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const emitBodySchema = z.object({
  title: optionalText(120),
  body: optionalText(500),
  tag: optionalText(128),
  sessionId: optionalText(128),
  directory: optionalText(4096),
  showWhenFocused: z.boolean().optional(),
}).refine((value) => value.title || value.body, { message: 'title or body required' });

interface PluginNotificationDependencies {
  readSettingsFromDiskMigrated: () => Promise<{ nativeNotificationsEnabled?: boolean; notificationMode?: string }>;
  emitDesktopNotification: (payload: NotificationPayload) => boolean;
  broadcastUiNotification: (payload: NotificationPayload, options: { desktopNotificationDelivered: boolean }) => void;
  now?: () => number;
}

export interface PluginNotificationInput {
  title?: unknown;
  body?: unknown;
  tag?: unknown;
  sessionId?: unknown;
  directory?: unknown;
  showWhenFocused?: unknown;
}

interface EmitRequest {
  body: PluginNotificationInput;
}

interface EmitResponse {
  setHeader: (name: string, value: string) => void;
  status: (status: number) => EmitResponse;
  json: (body: { error?: string; delivered?: boolean; reason?: string }) => void;
}

type EmitNext = <Failure>(error?: Failure) => void;
type EmitRouteHandler = (req: EmitRequest, res: EmitResponse, next: EmitNext) => void | Promise<void>;

export const createPluginNotificationEmitter = (dependencies: PluginNotificationDependencies) => {
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

  const emit = async (input: PluginNotificationInput) => {
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
      requireHidden: true,
      showWhenFocused: parsed.data.showWhenFocused === true || settings.notificationMode === 'always',
    };
    const desktopNotificationDelivered = emitDesktopNotification(payload) === true;
    broadcastUiNotification(payload, { desktopNotificationDelivered });
    return { status: 200, body: { delivered: true } };
  };

  return { emit };
};

export const registerNotificationEmitRoutes = (app: { post: (path: string, ...handlers: EmitRouteHandler[]) => void }, dependencies: {
  express: { json: (options: { limit: string }) => EmitRouteHandler };
  isAgentToolRequestAuthorized: (req: EmitRequest) => boolean;
  emitter: ReturnType<typeof createPluginNotificationEmitter>;
}) => {
  const { express, isAgentToolRequestAuthorized, emitter } = dependencies;

  const jsonBody = express.json({ limit: '16kb' });

  const respond = async (req: EmitRequest, res: EmitResponse, next: EmitNext) => {
    try {
      const result = await emitter.emit(req.body);
      if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(result.status).json(result.body);
    } catch (error) {
      return next(error);
    }
  };

  return {
    registerPluginRoute: () => {
      app.post(NOTIFICATION_EMIT_PATH, jsonBody, (req, res, next) => (
        isAgentToolRequestAuthorized(req) ? respond(req, res, next) : next()
      ));
    },
    registerApiRoute: () => {
      app.post(NOTIFICATION_EMIT_PATH, jsonBody, respond);
    },
  };
};
