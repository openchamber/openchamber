import type { Server } from 'node:http';
import type { WebSocket } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker, createRequestSecurityRuntime } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { SurfaceHostMessage } from '@openchamber/sdk/schemas';
import type { GuestRecord } from './contracts.js';
import type { holdGuestService, openGuestServiceRequest } from './service.js';

export type SurfaceGuest = GuestRecord & { service: NonNullable<GuestRecord['service']> };
export type SurfaceFrame = Omit<Extract<SurfaceHostMessage, { type: 'frame' }>, 'type' | 'bytes'> & { serviceSeq: number; bytes: Buffer };
export type SurfaceEndReason = Extract<SurfaceHostMessage, { type: 'ended' }>['reason'];
export type SurfaceController = Extract<SurfaceHostMessage, { type: 'control' }>['controller'];

export interface SurfaceViewer {
  id: string;
  ws: WebSocket;
  sentSeq: number;
  sentServiceSeq: number;
  shownServiceSeq: number;
  awaitingAck: boolean;
  gone: boolean;
}

export interface SurfaceSession {
  guestId: string;
  guest: SurfaceGuest;
  viewers: Map<string, SurfaceViewer>;
  latest: SurfaceFrame | null;
  controller: string;
  agentTimer: ReturnType<typeof setTimeout> | null;
  pumpAbort: AbortController | null;
  releaseHold: (() => void) | null;
  ended: boolean;
  queue: Promise<void | undefined>;
  handoffs: number;
}

export interface SurfaceRuntimeOptions {
  server: Server;
  uiAuthController: Partial<Pick<ReturnType<typeof createUiAuth>, 'enabled' | 'ensureSessionToken'>> | null;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: ReturnType<typeof createRequestSecurityRuntime>['rejectWebSocketUpgrade'];
  persistPath: string;
  findGuest: (id: string) => Promise<GuestRecord | null>;
  idleStopMs: number;
  openServiceRequest?: typeof openGuestServiceRequest;
  holdService?: typeof holdGuestService;
  createViewerId?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
