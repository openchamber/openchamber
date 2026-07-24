const STORAGE_KEY = 'permissionAutoAccept';

type PolicyContext = {
  globalState: {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => PromiseLike<void>;
  };
};

export type PermissionAutoAcceptSnapshot = {
  sessions: Record<string, boolean>;
  revision: number;
};

const normalizeSnapshot = (value: unknown): PermissionAutoAcceptSnapshot => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { sessions?: unknown }
    : {};
  const entries = source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
    ? Object.entries(source.sessions)
    : [];
  const sessions: Record<string, boolean> = {};
  for (const [sessionId, enabled] of entries) {
    if (sessionId && typeof enabled === 'boolean') sessions[sessionId] = enabled;
  }
  const revision = Number.isSafeInteger((source as { revision?: unknown }).revision)
    && Number((source as { revision?: unknown }).revision) >= 0
    ? Number((source as { revision?: unknown }).revision)
    : 0;
  return { sessions, revision };
};

const readPermissionAutoAcceptPolicy = (context: PolicyContext) =>
  normalizeSnapshot(context.globalState.get(STORAGE_KEY));

const operationQueues = new WeakMap<object, Promise<void>>();

const serialize = async <T>(context: PolicyContext, operation: () => Promise<T>): Promise<T> => {
  const owner = context.globalState as object;
  const previous = operationQueues.get(owner) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  operationQueues.set(owner, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (operationQueues.get(owner) === queued) operationQueues.delete(owner);
  }
};

async function setPermissionAutoAcceptPolicy(
  context: PolicyContext,
  sessionId: string,
  enabled: boolean,
  broadcast: (snapshot: PermissionAutoAcceptSnapshot) => PromiseLike<unknown>,
) {
  return serialize(context, async () => {
    const current = readPermissionAutoAcceptPolicy(context);
    const snapshot = {
      sessions: { ...current.sessions, [sessionId]: enabled },
      revision: current.revision + 1,
    };
    await context.globalState.update(STORAGE_KEY, snapshot);
    await broadcast(snapshot);
    return snapshot;
  });
}

export async function handlePermissionAutoAcceptBridgeMessage(
  message: { id: string; type: string; payload?: unknown },
  context?: PolicyContext,
  dependencies?: { broadcast: (snapshot: PermissionAutoAcceptSnapshot) => PromiseLike<unknown> },
) {
  if (message.type !== 'api:permission-auto-accept:get' && message.type !== 'api:permission-auto-accept:set') {
    return null;
  }
  if (!context) return { id: message.id, type: message.type, success: false, error: 'Extension context is unavailable' };

  if (message.type === 'api:permission-auto-accept:get') {
    const snapshot = await serialize(context, async () => readPermissionAutoAcceptPolicy(context));
    return { id: message.id, type: message.type, success: true, data: snapshot };
  }

  const payload = message.payload && typeof message.payload === 'object'
    ? message.payload as { sessionId?: unknown; enabled?: unknown }
    : {};
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) return { id: message.id, type: message.type, success: false, error: 'sessionId is required' };
  if (typeof payload.enabled !== 'boolean') {
    return { id: message.id, type: message.type, success: false, error: 'enabled must be a boolean' };
  }

  const snapshot = await setPermissionAutoAcceptPolicy(
    context,
    sessionId,
    payload.enabled,
    dependencies?.broadcast ?? (() => Promise.resolve()),
  );
  return { id: message.id, type: message.type, success: true, data: snapshot };
}
