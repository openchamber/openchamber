const STORAGE_KEY = 'permissionAutoAccept';

type PolicyStateStorage = {
  get: (key: string) => unknown;
  update: (key: string, value: unknown) => PromiseLike<void>;
};

type PolicyContext = {
  globalState: PolicyStateStorage;
  workspaceState?: PolicyStateStorage;
};

type PermissionAutoAcceptSnapshot = {
  default: boolean;
  sessions: Record<string, boolean>;
};

type PermissionAutoAcceptDependencies = {
  broadcast: (snapshot: PermissionAutoAcceptSnapshot) => PromiseLike<unknown>;
  getStorageIdentity?: (context: PolicyContext) => string;
};

type ResolvedPolicyStorage = {
  storage: PolicyStateStorage;
  key: string;
  legacyState?: PolicyStateStorage;
};

let operationQueue: Promise<void> = Promise.resolve();

const normalizeSnapshot = (value: unknown): PermissionAutoAcceptSnapshot => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { default?: unknown; sessions?: unknown }
    : {};
  const defaultEnabled = source.default === true;
  const entries = source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
    ? Object.entries(source.sessions)
    : [];
  const sessions: Record<string, boolean> = {};
  for (const [sessionId, enabled] of entries) {
    if (sessionId && typeof enabled === 'boolean') sessions[sessionId] = enabled;
  }
  return { default: defaultEnabled, sessions };
};

const normalizeStorageIdentity = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'workspace-local';
};

const resolvePolicyStorage = (
  context: PolicyContext,
  dependencies?: PermissionAutoAcceptDependencies,
): ResolvedPolicyStorage => {
  if (!context.workspaceState) {
    return { storage: context.globalState, key: STORAGE_KEY };
  }

  const identity = normalizeStorageIdentity(
    dependencies?.getStorageIdentity?.(context)
      ?? 'workspace-local',
  );
  return {
    storage: context.workspaceState,
    key: `${STORAGE_KEY}:${identity}`,
    legacyState: context.globalState,
  };
};

const migrateLegacyScopedPolicyUnqueued = async (
  resolution: ResolvedPolicyStorage,
): Promise<PermissionAutoAcceptSnapshot | null> => {
  const scopedValue = resolution.storage.get(resolution.key);
  if (scopedValue !== undefined) {
    return normalizeSnapshot(scopedValue);
  }

  const legacyState = resolution.legacyState;
  if (!legacyState) return null;

  const legacySnapshot = normalizeSnapshot(legacyState.get(STORAGE_KEY));
  if (Object.keys(legacySnapshot.sessions).length === 0) {
    return null;
  }

  const migratedSnapshot: PermissionAutoAcceptSnapshot = {
    default: false,
    sessions: { ...legacySnapshot.sessions },
  };
  await resolution.storage.update(resolution.key, migratedSnapshot);
  return migratedSnapshot;
};

const readPermissionAutoAcceptPolicyUnqueued = (resolution: ResolvedPolicyStorage): PermissionAutoAcceptSnapshot | null => {
  const scopedValue = resolution.storage.get(resolution.key);
  if (scopedValue === undefined) {
    return null;
  }
  return normalizeSnapshot(scopedValue);
};

const initializePermissionAutoAcceptPolicyUnqueued = async (
  resolution: ResolvedPolicyStorage,
): Promise<PermissionAutoAcceptSnapshot> => {
  const current = readPermissionAutoAcceptPolicyUnqueued(resolution);
  if (current) {
    return current;
  }

  const migrated = await migrateLegacyScopedPolicyUnqueued(resolution);
  if (migrated) return migrated;

  return { default: false, sessions: {} };
};

const persistPermissionAutoAcceptPolicyUnqueued = async (
  resolution: ResolvedPolicyStorage,
  snapshot: PermissionAutoAcceptSnapshot,
) => {
  await resolution.storage.update(resolution.key, snapshot);
};

const enqueuePolicyOperation = <T>(operation: () => Promise<T>): Promise<T> => {
  const task = operationQueue.then(operation, operation);
  operationQueue = task.then(() => undefined, () => undefined);
  return task;
};

const readPermissionAutoAcceptPolicy = async (
  context: PolicyContext,
  dependencies?: PermissionAutoAcceptDependencies,
) => {
  const resolution = resolvePolicyStorage(context, dependencies);
  const current = readPermissionAutoAcceptPolicyUnqueued(resolution);
  if (current) {
    return current;
  }

  return enqueuePolicyOperation(async () => initializePermissionAutoAcceptPolicyUnqueued(resolution));
};

async function setPermissionAutoAcceptPolicy(
  context: PolicyContext,
  sessionId: string,
  enabled: boolean,
  dependencies?: PermissionAutoAcceptDependencies,
) {
  const resolution = resolvePolicyStorage(context, dependencies);
  return enqueuePolicyOperation(async () => {
    const current = await initializePermissionAutoAcceptPolicyUnqueued(resolution);
    const snapshot = {
      default: current.default,
      sessions: { ...current.sessions, [sessionId]: enabled },
    };
    await persistPermissionAutoAcceptPolicyUnqueued(resolution, snapshot);
    await (dependencies?.broadcast ?? (() => Promise.resolve()))(snapshot);
    return snapshot;
  });
}

async function setPermissionAutoAcceptDefault(
  context: PolicyContext,
  enabled: boolean,
  dependencies?: PermissionAutoAcceptDependencies,
) {
  const resolution = resolvePolicyStorage(context, dependencies);
  return enqueuePolicyOperation(async () => {
    const current = await initializePermissionAutoAcceptPolicyUnqueued(resolution);
    const snapshot = {
      default: enabled,
      sessions: { ...current.sessions },
    };
    await persistPermissionAutoAcceptPolicyUnqueued(resolution, snapshot);
    await (dependencies?.broadcast ?? (() => Promise.resolve()))(snapshot);
    return snapshot;
  });
}

export async function handlePermissionAutoAcceptBridgeMessage(
  message: { id: string; type: string; payload?: unknown },
  context?: PolicyContext,
  dependencies?: PermissionAutoAcceptDependencies,
) {
  if (
    message.type !== 'api:permission-auto-accept:get'
    && message.type !== 'api:permission-auto-accept:set-session'
    && message.type !== 'api:permission-auto-accept:set-default'
  ) {
    return null;
  }
  if (!context) return { id: message.id, type: message.type, success: false, error: 'Extension context is unavailable' };

  if (message.type === 'api:permission-auto-accept:get') {
    return { id: message.id, type: message.type, success: true, data: await readPermissionAutoAcceptPolicy(context, dependencies) };
  }

  if (message.type === 'api:permission-auto-accept:set-default') {
    const payload = message.payload && typeof message.payload === 'object'
      ? message.payload as { enabled?: unknown }
      : {};
    if (typeof payload.enabled !== 'boolean') {
      return { id: message.id, type: message.type, success: false, error: 'enabled must be a boolean' };
    }

    const snapshot = await setPermissionAutoAcceptDefault(
      context,
      payload.enabled,
      dependencies,
    );
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
    dependencies,
  );
  return { id: message.id, type: message.type, success: true, data: snapshot };
}
