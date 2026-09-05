import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import {
  GUEST_REQUEST_TIMEOUT_MS,
  clampAttachRequest,
  clampPromptRequest,
  clampStartSessionRequest,
  hostMessageSchema,
  type AttachIssueRequest,
  type ComposeRequest,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type StartSessionRequest,
  type GuestConnection,
  type GuestMessage,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSettings,
  type HostReadyContext,
  type HostRequestErrorCode,
  type HostResultPayload,
  type SessionSnapshot,
  type StartSessionResult,
  type ToastRequest,
  type AgentStatusResult,
  isAgentStatusResult,
  isGuestRequestResult,
  isPromptResult,
  isStartSessionResult,
} from './protocol.ts';

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
  onReady: (listener: (context: HostReadyContext) => void) => () => void;
  onDirectory: (listener: (directory: string | null) => void) => () => void;
  onSession: (listener: (session: SessionSnapshot | null) => void) => () => void;
  onSessionLifecycle: (listener: (event: SessionLifecycleEvent) => void) => () => void;
  onConnection: (listener: (connection: GuestConnection) => void) => () => void;
  onSettings: (listener: (settings: GuestSettings) => void) => () => void;
  toast: (request: ToastRequest) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
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
  agentRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
  agentStatus: () => Promise<AgentStatusResult>;
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
  const pending = new Map<string, Pending>();
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

  const onMessage = (event: Event): void => {
    if (!(event instanceof MessageEvent)) return;
    if (!acceptSource(event.source)) return;
    const parsed = hostMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'ready') {
      lastReady = message.payload;
      lastLifecycle = lifecycleFromSession(message.payload.session);
      for (const listener of readyListeners) listener(message.payload);
      for (const listener of directoryListeners) listener(message.payload.directory);
      for (const listener of sessionListeners) listener(message.payload.session);
      if (lastLifecycle) {
        for (const listener of lifecycleListeners) listener(lastLifecycle);
      }
      for (const listener of connectionListeners) listener(message.payload.connection);
      for (const listener of settingsListeners) listener(message.payload.settings);
      return;
    }

    if (message.type === 'directory') {
      if (lastReady) {
        lastReady = { ...lastReady, directory: message.payload.directory };
      }
      for (const listener of directoryListeners) listener(message.payload.directory);
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
      for (const listener of sessionListeners) listener(message.payload.session);
      return;
    }

    if (message.type === 'session-lifecycle') {
      lastLifecycle = message.payload;
      for (const listener of lifecycleListeners) listener(message.payload);
      return;
    }

    if (message.type === 'connection') {
      if (lastReady) {
        lastReady = { ...lastReady, connection: message.payload.connection };
      }
      for (const listener of connectionListeners) listener(message.payload.connection);
      return;
    }

    if (message.type === 'settings') {
      if (lastReady) {
        lastReady = { ...lastReady, settings: message.payload.settings };
      }
      for (const listener of settingsListeners) listener(message.payload.settings);
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
  ): Promise<HostResultPayload | undefined> => {
    if (target.parent === target) {
      return Promise.reject(new HostRequestError('HOST_UNAVAILABLE', 'No host frame. This page is not in an iframe.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new HostRequestError('HOST_TIMEOUT', 'Host did not answer in time.'));
      }, requestTimeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      post(message);
    });
  };

  const request = (message: Exclude<GuestMessage, { type: 'hello' }>): Promise<void> => (
    send(message).then(() => undefined)
  );

  return {
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
    toast: (payload) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'toast',
      id: nextId(ids),
      payload,
    }),
    openUrl: (url) => request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'open-url',
      id: nextId(ids),
      payload: { url },
    }),
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
    startSession: (payload) => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'start-session',
      id: nextId(ids),
      payload: clampStartSessionRequest(payload),
    }).then((result) => {
      if (!isStartSessionResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return a session.');
      }
      return result;
    }),
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
    request: (payload) => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'request',
      id: nextId(ids),
      payload,
    }).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host request result was empty.');
      }
      return result;
    }),
    agentRequest: (payload) => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'agent-request',
      id: nextId(ids),
      payload,
    }).then((result) => {
      if (!isGuestRequestResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host agent request result was empty.');
      }
      return result;
    }),
    agentStatus: () => send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'agent-status',
      id: nextId(ids),
    }).then((result) => {
      if (!isAgentStatusResult(result)) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not return agent status.');
      }
      return result;
    }),
    dispose: () => {
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
    },
  };
};
