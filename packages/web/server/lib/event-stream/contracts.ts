import type { UpstreamFetch, UpstreamResponse } from './upstream-reader.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface SseEnvelope {
  eventId?: string | null | undefined;
  // The payload's own id, kept by the global hub's block parser when the SSE `id:` line names the cursor.
  bufferId?: string | null | undefined;
  directory?: string | null | undefined;
  spaceId?: string | null;
  payload?: JsonValue;
}

export interface StreamEvent {
  envelope?: SseEnvelope | null | undefined;
  payload: JsonValue;
  block?: string;
  eventId?: string | null | undefined;
  directory?: string | null | undefined;
}

export interface UpstreamEvent extends StreamEvent {
  envelope: SseEnvelope;
  block: string;
  eventId: string | null | undefined;
  directory: string | null | undefined;
}

export type TimeoutMs = number | (() => number);
export interface StreamSocket {
  readyState: number;
  bufferedAmount?: number;
  _ocBackpressureWarned?: boolean;
  send: (frame: string) => void;
  close: (code?: number, reason?: string) => void;
  ping: () => void;
  on: (event: 'close' | 'error', handler: () => void) => void;
}
export interface EventRouting {
  eventId?: string | null | undefined;
  directory?: string | null;
}

export interface WsEventFrame<T> {
  type: 'event';
  payload: T;
  eventId?: string;
  directory?: string;
}

export interface GlobalReadyFrame {
  type: 'ready';
  scope: 'global';
  replayReset?: boolean;
  replayed?: boolean;
  cursor?: string;
  // The client's cursor was answered (buffer, durable frames or upstream).
  resumed?: boolean;
  // The stream's current cursor, for a client that holds none.
  headEventId?: string;
}

export interface UpstreamConnection {
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  fetchImpl?: UpstreamFetch;
  upstreamStallTimeoutMs?: TimeoutMs | undefined;
  upstreamReconnectDelayMs?: TimeoutMs | undefined;
}

export type ForwardEventPayload = (
  payload: JsonValue,
  emit: (payload: JsonValue) => void,
  options?: { spaceId: string | null },
) => void;

export interface BridgeOptions {
  wsClients: Set<StreamSocket>;
  processForwardedEventPayload: ForwardEventPayload;
  triggerHealthCheck?: (() => void) | undefined;
  heartbeatIntervalMs: number;
}

export interface InitialStreamError {
  message: string;
  closeReason?: string;
  triggerHealthCheckFor?: boolean | UpstreamResponse | null;
}
