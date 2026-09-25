import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_STORAGE_KEY_MAX, GUEST_STORAGE_VALUE_BYTES, type GuestProjectsSnapshot, type GuestWorktreesSnapshot, type GuestSessionsSnapshot, type GuestWorkspaceQuery, type GuestWorkspaceSnapshot, type GuestStorageRequest, type GuestStorageResult } from './workspace.ts';
import type { JsonValue } from './contract.ts';
import {
  GUEST_FILE_CONTENT_MAX,
  GUEST_CLIPBOARD_TEXT_MAX,
  GUEST_TOAST_MAX,
  GUEST_FILE_PATH_MAX,
  GUEST_GENERATE_OUTPUT_TOKENS_MAX,
  GUEST_GENERATE_PROMPT_MAX,
  GUEST_GENERATE_SYSTEM_MAX,
  GUEST_GENERATE_TIMEOUT_MS,
  GUEST_REQUEST_TIMEOUT_MS,
  GUEST_RESOLVE_ERROR_MAX,
  isGuestFilePath,
  isGuestRequestPath,
  clampAttachRequest,
  clampBadgeCount,
  clampFrameHeight,
  isGuestCommitSha,
  clampPromptRequest,
  clampStartSessionRequest,
  readHostMessage,
  type AttachIssueRequest,
  type ActionResultPayload,
  type GuestActionItem,
  type ComposeRequest,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type StartSessionRequest,
  type GuestConnection,
  type GuestItem,
  type GuestMessage,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSettings,
  type HostReadyContext,
  type HostRequestErrorCode,
  type HostResultPayload,
  type ResolveRequest,
  type ResolveResultPayload,
  type SessionSnapshot,
  type StartSessionResult,
  type ToastRequest,
  type ServiceStatusResult,
  type FileListResult,
  type FileReadResult,
  type FileStatResult,
  type FileWriteResult,
  type GenerateRequest,
  type GenerateResult,
  isGenerateResult,
  isFileListResult,
  isFileReadResult,
  isFileStatResult,
  isJsonValue,
  isFileWriteResult,
  isServiceStatusResult,
  isGuestRequestResult,
  isPromptResult,
  isStartSessionResult,
} from './contract.ts';

export type HostFrame = {
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
  parent: {
    postMessage: (message: GuestMessage, targetOrigin: string) => void;
  };
};

export type HostClientOptions = {
  /** Test seam. Defaults to `window`. */
  target?: HostFrame;
  /** Test seam. Defaults to `source === parent`. */
  acceptSource?: (source: MessageEvent['source']) => boolean;
  /** Test seam. Defaults to `GUEST_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
};

export type HostClient = {
  listProjects: () => Promise<GuestProjectsSnapshot>;
  listWorktrees: (projectId: string) => Promise<GuestWorktreesSnapshot>;
  listSessions: (projectId: string) => Promise<GuestSessionsSnapshot>;
  onProjects: (listener: (snapshot: GuestProjectsSnapshot) => void) => Promise<() => void>;
  onWorktrees: (projectId: string, listener: (snapshot: GuestWorktreesSnapshot) => void) => Promise<() => void>;
  onSessions: (projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void) => Promise<() => void>;
  openSession: (sessionId: string) => Promise<void>;
  storage: {
    get: (key: string) => Promise<JsonValue | undefined>;
    set: (key: string, value: JsonValue) => Promise<void>;
    delete: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
  onReady: (listener: (context: HostReadyContext) => void) => () => void;
  onDirectory: (listener: (directory: string | null) => void) => () => void;
  onSession: (listener: (session: SessionSnapshot | null) => void) => () => void;
  onSessionLifecycle: (listener: (event: SessionLifecycleEvent) => void) => () => void;
  onConnection: (listener: (connection: GuestConnection) => void) => () => void;
  onSettings: (listener: (settings: GuestSettings) => void) => () => void;
  /**
   * The item this surface was opened for: a chip (`AttachIssueRequest`), a
   * message (`GuestMessageItem`), or a session (`GuestSessionItem`). Replays
   * the last value; `null` when there is none.
   */
  onItem: (listener: (item: GuestItem | null) => void) => () => void;
  /**
   * Answer the host when the user submits one of this package's
   * `contributes.commands`. Return the chip to attach, or `null` for nothing
   * (the host shows a short notice). A thrown error reaches the user as a
   * toast. One handler at a time; the returned function removes it.
   */
  onResolve: (handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) => () => void;
  /**
   * Run a `mode: "background"` action. Register synchronously after connectHost.
   * Await all work, including toast calls: the hidden frame is removed when
   * this handler settles. Throw to report failure. One handler at a time.
   */
  onAction: (handler: (item: GuestActionItem) => void | Promise<void>) => () => void;
  toast: (request: ToastRequest) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /**
   * Show a commit of the open project in the host's Diff view (commit scope).
   * `sha` is 7 to 64 hex characters; the host reads the commit itself. No open
   * project is `NO_DIRECTORY`, an unknown commit `NOT_FOUND`, a host without a
   * Diff view `UNSUPPORTED`.
   */
  openCommit: (sha: string) => Promise<void>;
  openSurface: (surfaceId: string) => Promise<void>;
  writeClipboard: (text: string) => Promise<void>;
  compose: (request: ComposeRequest) => Promise<void>;
  attach: (request: AttachIssueRequest) => Promise<void>;
  startSession: (request: StartSessionRequest) => Promise<StartSessionResult>;
  prompt: (request: PromptRequest) => Promise<PromptResult>;
  sessionLink: (request: AttachIssueRequest) => Promise<void>;
  close: () => Promise<void>;
  oauthStart: () => Promise<void>;
  oauthDisconnect: () => Promise<void>;
  request: (request: GuestRequest) => Promise<GuestRequestResult>;
  serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
  serviceStatus: () => Promise<ServiceStatusResult>;
  /**
   * Read a UTF-8 text file. A relative path is inside the open project
   * (capability `files`); `/…` or `~/…` must match a declared
   * `contributes.filesystem` pattern (capability `filesystem`). Over
   * `GUEST_FILE_CONTENT_MAX` characters is `FILE_TOO_LARGE`; a missing file
   * is `NOT_FOUND`.
   */
  readFile: (path: string) => Promise<FileReadResult>;
  /**
   * Write a UTF-8 text file atomically, creating parent directories. Same
   * path rules as `readFile`. Content over `GUEST_FILE_CONTENT_MAX` is
   * refused before sending.
   */
  writeFile: (path: string, content: string) => Promise<FileWriteResult>;
  /** Entries of a directory, sorted by name, capped at `GUEST_FILE_LIST_MAX`. Same path rules as `readFile`. */
  listDir: (path: string) => Promise<FileListResult>;
  /** Kind, size, and mtime of a path. A missing path is `kind: 'missing'`, not an error. Same path rules as `readFile`. */
  stat: (path: string) => Promise<FileStatResult>;
  /**
   * One-off text generation with the user's Small Model (capability
   * `model`). Nothing enters a session and no history is kept. `prompt` is
   * 1 to `GUEST_GENERATE_PROMPT_MAX` characters, `system` up to
   * `GUEST_GENERATE_SYSTEM_MAX`. No usable model is `NO_MODEL`; a model that
   * failed is `MODEL_FAILED`. Waits up to `GUEST_GENERATE_TIMEOUT_MS`.
   */
  generate: (request: GenerateRequest) => Promise<GenerateResult>;
  /** Number on this guest's rail icon (0 to `GUEST_BADGE_MAX`); `null` clears it. Opening the panel clears it too. */
  setBadge: (count: number | null) => Promise<void>;
  /**
   * The height the guest's content needs, in CSS px. On the Work Status
   * `status` surface the host sizes the frame to it, clamped to
   * `GUEST_STATUS_SECTION_HEIGHT_MIN`..`GUEST_STATUS_SECTION_HEIGHT_MAX`;
   * taller content scrolls inside the frame. Other surfaces fill their host
   * chrome and ignore it.
   */
  setHeight: (height: number) => Promise<void>;
  dispose: () => void;
};

export class HostRequestError extends Error {
  readonly code: HostRequestErrorCode;

  constructor(code: HostRequestErrorCode, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

type Pending = {
  resolve: (payload?: HostResultPayload) => void;
  reject: (error: HostRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
};

// The host drops a message its schema rejects without answering, so a bad
// path would otherwise surface only as HOST_TIMEOUT twenty seconds later.
const rejectBadPath = (): Promise<never> => Promise.reject(
  new HostRequestError('BAD_PATH', 'Request path must start with "/" and stay on the declared origin.'),
);

const rejectBadFilePath = (): Promise<never> => Promise.reject(
  new HostRequestError('BAD_PATH', `File path must be 1 to ${GUEST_FILE_PATH_MAX} characters without NUL or backslash.`),
);

const nextId = (n: { value: number }): string => {
  n.value += 1;
  return `oc-${n.value}`;
};

export const connectHost = (options: HostClientOptions = {}): HostClient => {
  const target = options.target ?? ('window' in globalThis ? window : null);
  if (!target) {
    throw new HostRequestError('HOST_UNAVAILABLE', 'No window. connectHost runs in a browser frame.');
  }
  const acceptSource = options.acceptSource ?? ((source: MessageEvent['source']) => source === target.parent);
  const requestTimeoutMs = options.requestTimeoutMs ?? GUEST_REQUEST_TIMEOUT_MS;

  const readyListeners = new Set<(context: HostReadyContext) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const sessionListeners = new Set<(session: SessionSnapshot | null) => void>();
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>();
  const connectionListeners = new Set<(connection: GuestConnection) => void>();
  const settingsListeners = new Set<(settings: GuestSettings) => void>();
  const itemListeners = new Set<(item: GuestItem | null) => void>();
  let resolveHandler: ((request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) | null = null;
  let actionHandler: ((item: GuestActionItem) => void | Promise<void>) | null = null;
  const pending = new Map<string, Pending>();
  const workspaceListeners = new Map<string, (snapshot: GuestWorkspaceSnapshot) => void>();
  let disposed = false;
  const ids = { value: 0 };
  let lastReady: HostReadyContext | null = null;
  let lastLifecycle: SessionLifecycleEvent | null = null;

  const lifecycleFromSession = (session: SessionSnapshot | null): SessionLifecycleEvent | null => {
    if (!session) return null;
    return {
      sessionId: session.id,
      phase: session.busy ? 'started' : 'completed',
    };
  };

  const post = (message: GuestMessage): void => {
    target.parent.postMessage(message, '*');
  };

  // One listener that throws must not starve the ones after it; the error
  // surfaces on the console the way an event handler's would.
  const emit = <T,>(listeners: Iterable<(value: T) => void>, value: T): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const onMessage = (event: Event): void => {
    if (!(event instanceof MessageEvent)) return;
    if (!acceptSource(event.source)) return;
    const message = readHostMessage(event.data);
    if (!message) return;
    if (message.type === 'workspace') {
      const listener = workspaceListeners.get(message.payload.subscriptionId);
      if (listener) emit([listener], message.payload.snapshot);
      return;
    }

    if (message.type === 'ready') {
      lastReady = message.payload;
      lastLifecycle = lifecycleFromSession(message.payload.session);
      emit(readyListeners, message.payload);
      emit(directoryListeners, message.payload.directory);
      emit(sessionListeners, message.payload.session);
      if (lastLifecycle) {
        emit(lifecycleListeners, lastLifecycle);
      }
      emit(connectionListeners, message.payload.connection);
      emit(settingsListeners, message.payload.settings);
      emit(itemListeners, message.payload.item);
      return;
    }

    if (message.type === 'directory') {
      if (lastReady) {
        lastReady = { ...lastReady, directory: message.payload.directory };
      }
      emit(directoryListeners, message.payload.directory);
      return;
    }

    if (message.type === 'session') {
      if (lastReady) {
        lastReady = { ...lastReady, session: message.payload.session };
      }
      if (!message.payload.session) {
        lastLifecycle = null;
      } else if (lastLifecycle?.sessionId !== message.payload.session.id) {
        lastLifecycle = lifecycleFromSession(message.payload.session);
      }
      emit(sessionListeners, message.payload.session);
      return;
    }

    if (message.type === 'session-lifecycle') {
      lastLifecycle = message.payload;
      emit(lifecycleListeners, message.payload);
      return;
    }

    if (message.type === 'connection') {
      if (lastReady) {
        lastReady = { ...lastReady, connection: message.payload.connection };
      }
      emit(connectionListeners, message.payload.connection);
      return;
    }

    if (message.type === 'settings') {
      if (lastReady) {
        lastReady = { ...lastReady, settings: message.payload.settings };
      }
      emit(settingsListeners, message.payload.settings);
      return;
    }

    if (message.type === 'item') {
      if (lastReady) {
        lastReady = { ...lastReady, item: message.payload.item };
      }
      emit(itemListeners, message.payload.item);
      return;
    }

    if (message.type === 'action') {
      const answer = (payload: ActionResultPayload): void => {
        if (!disposed) post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
          type: 'action-result', id: message.id, payload });
      };
      const handler = actionHandler;
      if (!handler) {
        answer({ ok: false, error: 'This extension does not handle background actions.' });
        return;
      }
      Promise.resolve().then(() => handler(message.payload)).then(
        () => answer({ ok: true }),
        (error) => {
          const text = (error instanceof Error ? error.message : String(error)).trim();
          answer({ ok: false, error: (text || 'Action failed.').slice(0, GUEST_RESOLVE_ERROR_MAX) });
        },
      );
      return;
    }

    if (message.type === 'resolve') {
      const answer = (payload: ResolveResultPayload): void => {
        post({
          channel: OPENCHAMBER_SDK_CHANNEL,
          v: OPENCHAMBER_SDK_API_VERSION,
          type: 'resolve-result',
          id: message.id,
          payload,
        });
      };
      const handler = resolveHandler;
      if (!handler) {
        answer({ error: 'This extension does not resolve commands.' });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.payload))
        .then(
          (item) => answer({ item: item ? clampAttachRequest(item) : null }),
          (error) => {
            const text = (error instanceof Error ? error.message : String(error)).trim();
            answer({ error: (text || 'Command failed.').slice(0, GUEST_RESOLVE_ERROR_MAX) });
          },
        );
      return;
    }

    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.payload);
      return;
    }
    waiter.reject(new HostRequestError(message.code, message.error));
  };

  target.addEventListener('message', onMessage);
  post({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: OPENCHAMBER_SDK_API_VERSION,
    type: 'hello',
  });

  const send = (
    message: Exclude<GuestMessage, { type: 'hello' }>,
    timeoutMs: number = requestTimeoutMs,
  ): Promise<HostResultPayload | undefined> => {
    if (disposed || target.parent === target) {
      return Promise.reject(new HostRequestError('HOST_UNAVAILABLE', 'No host frame. This page is not in an iframe.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new HostRequestError('HOST_TIMEOUT', 'Host did not answer in time.'));
      }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      post(message);
    });
  };

  const request = (message: Exclude<GuestMessage, { type: 'hello' }>): Promise<void> => (
    send(message).then(() => undefined)
  );

  const envelope: Pick<GuestMessage, 'channel' | 'v'> = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION };
  const requireIdentity = (value: string, maximum = 1024): void => {
    if (!value.trim() || value.length > maximum) throw new HostRequestError('HOST_REJECTED', `Identity must contain 1 to ${maximum} characters.`);
  };
  const readWorkspace = async (query: GuestWorkspaceQuery): Promise<GuestWorkspaceSnapshot> => {
    if (query.kind !== 'projects') requireIdentity(query.projectId);
    const result = await send({ ...envelope, type: 'workspace-read', id: nextId(ids), payload: query });
    if (!result || !('kind' in result) || !('state' in result) || result.kind !== query.kind) {
      throw new HostRequestError('HOST_REJECTED', 'Host did not return workspace data.');
    }
    return result;
  };
  const subscribeWorkspace = async (query: GuestWorkspaceQuery, listener: (snapshot: GuestWorkspaceSnapshot) => void): Promise<() => void> => {
    if (query.kind !== 'projects') requireIdentity(query.projectId);
    const subscriptionId = nextId(ids);
    workspaceListeners.set(subscriptionId, listener);
    try {
      await request({ ...envelope, type: 'workspace-subscribe', id: nextId(ids), payload: { subscriptionId, query } });
    } catch (error) {
      workspaceListeners.delete(subscriptionId);
      if (!disposed) post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      throw error;
    }
    return () => {
      if (!workspaceListeners.delete(subscriptionId) || disposed) return;
      post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
    };
  };
  const storage = async (payload: GuestStorageRequest): Promise<GuestStorageResult> => {
    if ('key' in payload && (payload.key.length === 0 || payload.key.length > GUEST_STORAGE_KEY_MAX)) {
      throw new HostRequestError('HOST_REJECTED', 'Storage key must contain 1 to 128 characters.');
    }
    if (payload.op === 'set' && !isJsonValue(payload.value)) {
      throw new HostRequestError('HOST_REJECTED', 'Storage values must be JSON.');
    }
    if (payload.op === 'set' && new TextEncoder().encode(JSON.stringify(payload.value)).length > GUEST_STORAGE_VALUE_BYTES) {
      throw new HostRequestError('HOST_REJECTED', 'Storage value exceeds 64 KiB.');
    }
    const result = await send({ ...envelope, type: 'storage', id: nextId(ids), payload });
    if (!result || !('storage' in result) || result.op !== payload.op) throw new HostRequestError('HOST_REJECTED', 'Host did not return storage data.');
    return result;
  };

  return {
    onAction: (handler) => {
      actionHandler = handler;
      return () => { if (actionHandler === handler) actionHandler = null; };
    },
    listProjects: async () => {
      const result = await readWorkspace({ kind: 'projects' });
      if (result.kind !== 'projects') throw new HostRequestError('HOST_REJECTED', 'Expected projects.');
      return result;
    },
    listWorktrees: async (projectId) => {
      const result = await readWorkspace({ kind: 'worktrees', projectId });
      if (result.kind !== 'worktrees') throw new HostRequestError('HOST_REJECTED', 'Expected worktrees.');
      return result;
    },
    listSessions: async (projectId) => {
      const result = await readWorkspace({ kind: 'sessions', projectId });
      if (result.kind !== 'sessions') throw new HostRequestError('HOST_REJECTED', 'Expected sessions.');
      return result;
    },
    onProjects: (listener) => subscribeWorkspace({ kind: 'projects' }, (snapshot) => { if (snapshot.kind === 'projects') listener(snapshot); }),
    onWorktrees: (projectId, listener) => subscribeWorkspace({ kind: 'worktrees', projectId }, (snapshot) => { if (snapshot.kind === 'worktrees') listener(snapshot); }),
    onSessions: (projectId, listener) => subscribeWorkspace({ kind: 'sessions', projectId }, (snapshot) => { if (snapshot.kind === 'sessions') listener(snapshot); }),
    openSession: async (sessionId) => {
      requireIdentity(sessionId);
      await request({ ...envelope, type: 'open-session', id: nextId(ids), payload: { sessionId } });
    },
    storage: {
      get: async (key) => {
        const result = await storage({ op: 'get', key });
        return result.op === 'get' && result.found ? result.value : undefined;
      },
      set: async (key, value) => { await storage({ op: 'set', key, value }); },
      delete: async (key) => { await storage({ op: 'delete', key }); },
      keys: async () => {
        const result = await storage({ op: 'keys' });
        if (result.op !== 'keys') throw new HostRequestError('HOST_REJECTED', 'Expected storage keys.');
        return result.keys;
      },
    },
    onReady: (listener) => {
      readyListeners.add(listener);
      if (lastReady) listener(lastReady);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onDirectory: (listener) => {
      directoryListeners.add(listener);
      if (lastReady) listener(lastReady.directory);
      return () => {
        directoryListeners.delete(listener);
      };
    },
    onSession: (listener) => {
      sessionListeners.add(listener);
      if (lastReady) listener(lastReady.session);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    onSessionLifecycle: (listener) => {
      lifecycleListeners.add(listener);
      if (lastLifecycle) listener(lastLifecycle);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
    onConnection: (listener) => {
      connectionListeners.add(listener);
      if (lastReady) listener(lastReady.connection);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    onSettings: (listener) => {
      settingsListeners.add(listener);
      if (lastReady) listener(lastReady.settings);
      return () => {
        settingsListeners.delete(listener);
      };
    },
    onItem: (listener) => {
      itemListeners.add(listener);
      if (lastReady) listener(lastReady.item);
      return () => {
        itemListeners.delete(listener);
      };
    },
    onResolve: (handler) => {
      resolveHandler = handler;
      return () => {
        if (resolveHandler === handler) resolveHandler = null;
      };
    },
    toast: (payload) => {
      const message = payload.message.trim();
      if (!message || message.length > GUEST_TOAST_MAX) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast message must contain 1 to ${GUEST_TOAST_MAX} characters.`));
      }
      if (payload.copy && payload.copy !== true && (!payload.copy.text.length || payload.copy.text.length > GUEST_CLIPBOARD_TEXT_MAX)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast copy text must contain 1 to ${GUEST_CLIPBOARD_TEXT_MAX} characters.`));
      }
      return request({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'toast',
        id: nextId(ids),
        payload: { ...payload, message },
      });
    },
    openUrl: (url) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-url',
      id: nextId(ids),
      payload: { url },
    }),
    openCommit: (sha) => (isGuestCommitSha(sha) ? request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-commit',
      id: nextId(ids),
      payload: { sha },
    }) : Promise.reject(new HostRequestError('HOST_REJECTED', 'Commit id must be 7 to 64 hex characters.'))),
    openSurface: (surfaceId) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-surface',
      id: nextId(ids),
      payload: { surfaceId },
    }),
    writeClipboard: (text) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'clipboard-write',
      id: nextId(ids),
      payload: { text },
    }),
    compose: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'compose',
      id: nextId(ids),
      payload,
    }),
    attach: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'attach',
      id: nextId(ids),
      payload: clampAttachRequest(payload),
    }),
    startSession: async (payload) => {
      if (payload.projectId !== undefined) requireIdentity(payload.projectId);
      const worktree = payload.worktree;
      if (worktree && worktree !== true) {
        if (worktree.kind === 'existing') requireIdentity(worktree.directory);
        else {
          if (worktree.name !== undefined) requireIdentity(worktree.name, 200);
          if (worktree.baseBranch !== undefined) requireIdentity(worktree.baseBranch, 200);
        }
      }
      const result = await send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'start-session',
      id: nextId(ids),
      payload: clampStartSessionRequest(payload),
    }, options.requestTimeoutMs ?? 180_000);
      if (!isStartSessionResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return a session.');
      }
      return result;
    },
    prompt: (payload) => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'prompt',
      id: nextId(ids),
      payload: clampPromptRequest(payload),
    }).then((result) => {
      if (!isPromptResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return a prompt result.');
      }
      return result;
    }),
    sessionLink: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'session-link',
      id: nextId(ids),
      payload: clampAttachRequest(payload),
    }),
    close: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'close',
      id: nextId(ids),
    }),
    oauthStart: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'oauth-start',
      id: nextId(ids),
    }),
    oauthDisconnect: () => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'oauth-disconnect',
      id: nextId(ids),
    }),
    request: (payload) => (isGuestRequestPath(payload.path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'request',
      id: nextId(ids),
      payload,
    }) : rejectBadPath()).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host request result was empty.');
      }
      return result;
    }),
    serviceRequest: (payload) => (isGuestRequestPath(payload.path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'service-request',
      id: nextId(ids),
      payload,
    }) : rejectBadPath()).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host service request result was empty.');
      }
      return result;
    }),
    serviceStatus: () => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'service-status',
      id: nextId(ids),
    }).then((result) => {
      if (!isServiceStatusResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return service status.');
      }
      return result;
    }),
    readFile: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-read',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileReadResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return file content.');
      }
      return result;
    }),
    writeFile: (path, content) => {
      if (!isGuestFilePath(path)) {
        return rejectBadFilePath();
      }
      if (content.length > GUEST_FILE_CONTENT_MAX) {
        return Promise.reject(new HostRequestError('FILE_TOO_LARGE', `Content is over ${GUEST_FILE_CONTENT_MAX} characters.`));
      }
      return send({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'file-write',
        id: nextId(ids),
        payload: { path, content },
      }).then((result) => {
        if (!isFileWriteResult(result)) {
          throw new HostRequestError('HOST_REJECTED', 'Host did not confirm the write.');
        }
        return result;
      });
    },
    listDir: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-list',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileListResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return directory entries.');
      }
      return result;
    }),
    stat: (path) => (isGuestFilePath(path) ? send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'file-stat',
      id: nextId(ids),
      payload: { path },
    }) : rejectBadFilePath()).then((result) => {
      if (!isFileStatResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return file status.');
      }
      return result;
    }),
    generate: (input) => {
      const prompt = input.prompt.trim();
      const system = input.system?.trim();
      if (prompt.length === 0 || prompt.length > GUEST_GENERATE_PROMPT_MAX) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `Prompt must be 1 to ${GUEST_GENERATE_PROMPT_MAX} characters.`));
      }
      if (system !== undefined && (system.length === 0 || system.length > GUEST_GENERATE_SYSTEM_MAX)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', `System prompt must be 1 to ${GUEST_GENERATE_SYSTEM_MAX} characters.`));
      }
      const maxOutputTokens = input.maxOutputTokens === undefined
        ? undefined
        : Math.min(GUEST_GENERATE_OUTPUT_TOKENS_MAX, Math.max(1, Math.floor(input.maxOutputTokens)));
      if (maxOutputTokens !== undefined && !Number.isFinite(maxOutputTokens)) {
        return Promise.reject(new HostRequestError('HOST_REJECTED', 'maxOutputTokens must be a number.'));
      }
      const payload: GenerateRequest = { prompt };
      if (system !== undefined) payload.system = system;
      if (maxOutputTokens !== undefined) payload.maxOutputTokens = maxOutputTokens;
      // The model answers slower than any other host call, so this one waits longer.
      return send({
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'generate',
        id: nextId(ids),
        payload,
      }, options.requestTimeoutMs ?? GUEST_GENERATE_TIMEOUT_MS).then((result) => {
        if (!isGenerateResult(result)) {
          throw new HostRequestError('HOST_REJECTED', 'Host did not return generated text.');
        }
        return result;
      });
    },
    setBadge: (count) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'badge',
      id: nextId(ids),
      payload: { count: clampBadgeCount(count) },
    }),
    setHeight: (height) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'resize',
      id: nextId(ids),
      payload: { height: clampFrameHeight(height) },
    }),
    dispose: () => {
      for (const subscriptionId of workspaceListeners.keys()) {
        post({ ...envelope, type: 'workspace-unsubscribe', id: nextId(ids), payload: { subscriptionId } });
      }
      workspaceListeners.clear();
      disposed = true;
      resolveHandler = null;
      actionHandler = null;
      target.removeEventListener('message', onMessage);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new HostRequestError('HOST_UNAVAILABLE', 'Host client was disposed.'));
      }
      pending.clear();
      readyListeners.clear();
      directoryListeners.clear();
      sessionListeners.clear();
      lifecycleListeners.clear();
      connectionListeners.clear();
      settingsListeners.clear();
      itemListeners.clear();
    },
  };
};
