import type {
  GuestSessionEventType,
  GuestSessionEventContent,
  GuestSessionEventRequest,
  GuestQuestionAskedContent,
} from '@openchamber/sdk';
import type { GuestRecord } from './contracts.js';
import type { GuestServiceRequest } from './service.js';
import type { JsonValue, JsonObject } from '../shared/json-values.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

export type StoredMetadata = SessionMetadata | JsonValue | undefined;

export type SessionEventSubscriber = GuestRecord & {
  sessionEvents: NonNullable<GuestRecord['sessionEvents']>;
  capabilityGrants: NonNullable<GuestRecord['capabilityGrants']>;
};

export interface SessionEventsOptions {
  listGuests: () => Promise<GuestRecord[]>;
  proxyServiceRequest: (params: Omit<GuestServiceRequest, 'service'> & { service: GuestRecord['service']; responseMax: number }) => Promise<{ status: number; body: string }>;
  persistPath: string;
  buildOpenCodeUrl: (path: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  fetchLastAssistantMessageText: (sessionId: string, messageId: string | undefined, maxLength: number) => Promise<string>;
  readSessionMetadata?: ((sessionId: string | null) => StoredMetadata | Promise<StoredMetadata>) | null;
  isSessionAutoAccepting?: (sessionId: string, directory: string | null, requestId: string) => Promise<boolean> | boolean;
  isInAutoReview?: (sessionId: string, turnEndedAt: number) => boolean;
  now?: () => number;
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  createId?: () => string;
  warn?: (...args: unknown[]) => void;
}

export interface PreparedSessionEvent {
  guest: SessionEventSubscriber;
  type: GuestSessionEventType;
  body: string;
}

export interface SessionEventQueue {
  guest: SessionEventSubscriber;
  items: Array<Pick<PreparedSessionEvent, 'type' | 'body'>>;
  running: boolean;
  backoffUntil: number;
  warnedFull: boolean;
  warnedNoService: boolean;
}

export interface SessionParentCacheEntry {
  at: number;
  pending?: Promise<JsonObject | JsonValue[] | null>;
  parentId?: string | null;
  directory?: string | null;
}

export type SessionEventAsk = GuestQuestionAskedContent['ask'];

export interface SessionEventAnnouncement {
  type: GuestSessionEventType;
  payload: JsonValue;
  directory: string;
  subscribers: SessionEventSubscriber[];
  permission?: { requestId: string };
  question?: { kind: 'form' | 'page'; id: string };
  contentOf: (record: JsonObject | JsonValue[] | null) => Promise<GuestSessionEventContent>;
}

export type SessionEventRequest = Omit<GuestSessionEventRequest, 'event'> & {
  event: Omit<GuestSessionEventRequest['event'], 'session'> & {
    session: { id: string | null; parentId: string | null };
  };
};

export interface SessionEventPreparation {
  items: PreparedSessionEvent[] | null;
}
