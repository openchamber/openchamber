const STORAGE_KEY = 'permissionAutoAccept';

type PolicyContext = {
  globalState: {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => PromiseLike<void>;
  };
};

export type PermissionAutoAcceptSnapshot = {
  sessions: Record<string, boolean>;
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
  return { sessions };
};

const readPermissionAutoAcceptPolicy = (context: PolicyContext) =>
  normalizeSnapshot(context.globalState.get(STORAGE_KEY));

async function setPermissionAutoAcceptPolicy(
  context: PolicyContext,
  sessionId: string,
  enabled: boolean,
  broadcast: (snapshot: PermissionAutoAcceptSnapshot) => PromiseLike<unknown>,
) {
  const current = readPermissionAutoAcceptPolicy(context);
  const snapshot = {
    sessions: { ...current.sessions, [sessionId]: enabled },
  };
  await context.globalState.update(STORAGE_KEY, snapshot);
  await broadcast(snapshot);
  return snapshot;
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
    return { id: message.id, type: message.type, success: true, data: readPermissionAutoAcceptPolicy(context) };
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
