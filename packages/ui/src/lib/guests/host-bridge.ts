import {
  GUEST_SESSION_AGENT_MAX,
  GUEST_SESSION_MODEL_MAX,
  OPENCHAMBER_SDK_API_VERSION,
  OPENCHAMBER_SDK_CHANNEL,
  type AttachIssueRequest,
  type GuestItem,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type SessionLifecyclePhase,
  type StartSessionRequest,
  type GuestConnection,
  type GuestMessage,
  type GuestRequest,
  type GuestSettings,
  type HostMessage,
  type HostReadyContext,
  type HostRequestErrorCode,
  type HostResultPayload,
  type ResolveResultPayload,
  type SessionSnapshot,
  type StartSessionResult,
  type ToastKind,
} from '@openchamber/sdk';

import type { GuestFileProxyResult, GuestFileRequest } from '@/lib/guests/files';
import type { GuestRequestProxyResult } from '@/lib/guests/oauth';

import { isContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';

type HostBridgeEffects = {
  toast: (kind: ToastKind, message: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  openSurface: (mode: ContextPanelMode) => void;
  writeClipboard: (text: string) => Promise<boolean>;
  compose: (text: string, mode: 'replace' | 'append') => void;
  attach: (issue: AttachIssueRequest) => void;
  startSession: (request: StartSessionRequest) => Promise<
    | StartSessionResult
    | { ok: false; code: HostRequestErrorCode; message: string }
    | null
  >;
  prompt: (request: PromptRequest) => Promise<
    | { ok: true; result: PromptResult }
    | { ok: false; code: HostRequestErrorCode; message: string }
  >;
  sessionLink: (issue: AttachIssueRequest) => Promise<
    | { ok: true }
    | { ok: false; code: HostRequestErrorCode; message: string }
  >;
  close: () => void;
  oauthStart: () => Promise<boolean>;
  oauthDisconnect: () => Promise<boolean>;
  request: (request: GuestRequest) => Promise<GuestRequestProxyResult>;
  serviceRequest: (request: GuestRequest) => Promise<GuestRequestProxyResult>;
  serviceStatus: () => Promise<
    | { ok: true; result: { status: import('@openchamber/sdk').ServiceStatus } }
    | { ok: false; code: HostRequestErrorCode; message: string }
  >;
  /** One handler for read, write, list, and stat; the pane checks scope and grant, the server does the rest. */
  file: (request: GuestFileRequest) => Promise<GuestFileProxyResult>;
  /** Rail badge for this guest; `null` clears. */
  setBadge: (count: number | null) => void;
  /** The guest answered a host `resolve` with this id. Not a request, so no `result` goes back. */
  resolveResult: (id: string, payload: ResolveResultPayload) => void;
};

export const buildReadyMessage = (payload: HostReadyContext): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'ready',
  payload,
});

export const buildDirectoryMessage = (directory: string | null): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'directory',
  payload: { directory },
});

export const buildSessionMessage = (session: SessionSnapshot | null): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'session',
  payload: { session },
});

export const buildConnectionMessage = (connection: GuestConnection): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'connection',
  payload: { connection },
});

export const buildSettingsMessage = (settings: GuestSettings): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'settings',
  payload: { settings },
});

export const buildItemMessage = (item: GuestItem | null): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'item',
  payload: { item },
});

export const buildResolveMessage = (id: string, command: string, args: string): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'resolve',
  id,
  payload: { command, args },
});

export const buildSessionLifecycleMessage = (event: SessionLifecycleEvent): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'session-lifecycle',
  payload: event,
});

export const guestSessionLifecyclePhase = (
  status: { type?: string } | null | undefined,
): SessionLifecyclePhase | null => {
  if (status?.type === 'busy' || status?.type === 'retry') {
    return 'started';
  }
  if (status?.type === 'idle') {
    return 'completed';
  }
  if (status?.type) {
    return 'failure';
  }
  return null;
};

export type GuestSessionSource = {
  id: string;
  title?: string | null;
  busy?: boolean;
  model?: string | null;
  agent?: string | null;
};

export const guestSessionModelId = (
  model: { providerID?: string | null; id?: string | null } | null | undefined,
): string | undefined => {
  const provider = model?.providerID?.trim();
  const id = model?.id?.trim();
  if (!provider || !id) return undefined;
  return `${provider}/${id}`;
};

export const toGuestSessionSnapshot = (
  session: GuestSessionSource | null | undefined,
): SessionSnapshot | null => {
  if (!session?.id) return null;
  const title = session.title?.trim();
  const snapshot: SessionSnapshot = {
    id: session.id,
    title: title || session.id,
    busy: Boolean(session.busy),
  };
  const model = session.model?.trim().slice(0, GUEST_SESSION_MODEL_MAX);
  if (model) snapshot.model = model;
  const agent = session.agent?.trim().slice(0, GUEST_SESSION_AGENT_MAX);
  if (agent) snapshot.agent = agent;
  return snapshot;
};

const okResult = (id: string, payload?: HostResultPayload): HostMessage => {
  if (payload) {
    return {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id,
      ok: true,
      payload,
    };
  }
  return {
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: OPENCHAMBER_SDK_API_VERSION,
    type: 'result',
    id,
    ok: true,
  };
};

const errorResult = (id: string, error: string, code: HostRequestErrorCode = 'HOST_REJECTED'): HostMessage => ({
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'result',
  id,
  ok: false,
  error,
  code,
});

const fileResult = (id: string, result: GuestFileProxyResult): HostMessage => (
  result.ok ? okResult(id, result.result) : errorResult(id, result.message, result.code)
);

const isHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export const answerGuestMessage = async (
  message: GuestMessage,
  effects: HostBridgeEffects,
): Promise<HostMessage | null> => {
  switch (message.type) {
    case 'hello':
      return null;
    case 'toast':
      effects.toast(message.payload.kind, message.payload.message);
      return okResult(message.id);
    case 'open-url': {
      if (!isHttpUrl(message.payload.url)) {
        return errorResult(message.id, 'URL must be http or https.');
      }
      const opened = await effects.openUrl(message.payload.url);
      return opened ? okResult(message.id) : errorResult(message.id, 'Could not open URL.');
    }
    case 'open-surface': {
      if (!isContextPanelMode(message.payload.surfaceId)) {
        return errorResult(message.id, 'Unknown surface.');
      }
      effects.openSurface(message.payload.surfaceId);
      return okResult(message.id);
    }
    case 'clipboard-write': {
      const copied = await effects.writeClipboard(message.payload.text);
      return copied ? okResult(message.id) : errorResult(message.id, 'Could not write clipboard.');
    }
    case 'compose':
      effects.compose(message.payload.text, message.payload.mode ?? 'append');
      return okResult(message.id);
    case 'attach': {
      if (!isHttpUrl(message.payload.url)) {
        return errorResult(message.id, 'URL must be http or https.');
      }
      effects.attach(message.payload);
      return okResult(message.id);
    }
    case 'start-session': {
      if (!isHttpUrl(message.payload.url)) {
        return errorResult(message.id, 'URL must be http or https.');
      }
      const started = await effects.startSession(message.payload);
      if (!started) {
        return errorResult(message.id, 'Could not start that session.');
      }
      if ('sessionId' in started) {
        return okResult(message.id, started);
      }
      return errorResult(message.id, started.message, started.code);
    }
    case 'prompt': {
      const prompted = await effects.prompt(message.payload);
      if (!prompted.ok) {
        return errorResult(message.id, prompted.message, prompted.code);
      }
      return okResult(message.id, prompted.result);
    }
    case 'session-link': {
      if (!isHttpUrl(message.payload.url)) {
        return errorResult(message.id, 'URL must be http or https.');
      }
      const linked = await effects.sessionLink(message.payload);
      if (!linked.ok) {
        return errorResult(message.id, linked.message, linked.code);
      }
      return okResult(message.id);
    }
    case 'close':
      effects.close();
      return okResult(message.id);
    case 'oauth-start': {
      const started = await effects.oauthStart();
      return started ? okResult(message.id) : errorResult(message.id, 'Could not start OAuth.');
    }
    case 'oauth-disconnect': {
      const disconnected = await effects.oauthDisconnect();
      return disconnected ? okResult(message.id) : errorResult(message.id, 'Could not disconnect.');
    }
    case 'request': {
      const result = await effects.request(message.payload);
      if (!result.ok) {
        return errorResult(message.id, result.message, result.code);
      }
      return okResult(message.id, result.result);
    }
    case 'service-request': {
      const result = await effects.serviceRequest(message.payload);
      if (!result.ok) {
        return errorResult(message.id, result.message, result.code);
      }
      return okResult(message.id, result.result);
    }
    case 'service-status': {
      const result = await effects.serviceStatus();
      if (!result.ok) {
        return errorResult(message.id, result.message, result.code);
      }
      return okResult(message.id, result.result);
    }
    case 'file-read':
      return fileResult(message.id, await effects.file({ op: 'read', path: message.payload.path }));
    case 'file-write':
      return fileResult(message.id, await effects.file({ op: 'write', path: message.payload.path, content: message.payload.content }));
    case 'file-list':
      return fileResult(message.id, await effects.file({ op: 'list', path: message.payload.path }));
    case 'file-stat':
      return fileResult(message.id, await effects.file({ op: 'stat', path: message.payload.path }));
    case 'badge':
      effects.setBadge(message.payload.count);
      return okResult(message.id);
    case 'resolve-result':
      effects.resolveResult(message.id, message.payload);
      return null;
  }
};
