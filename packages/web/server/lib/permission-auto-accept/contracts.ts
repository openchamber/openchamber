import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { JsonValue } from '../shared/json-values.js';
import type { RoutingPermission } from '../routing/jev.js';
import type { PermissionMode } from './modes.js';

export interface PermissionPolicy {
  sessions: Partial<Record<string, PermissionMode>>;
  revision: number;
}

export interface PermissionPolicySnapshot {
  sessions: Record<string, boolean>;
  modes: PermissionPolicy['sessions'];
  revision: number;
}

export interface PermissionSettings {
  permissionAutoAccept?: JsonValue;
  permissionDefaultMode?: JsonValue;
}

export type PermissionDirectory = JsonValue | undefined;
export type PermissionOutcome = 'ignored' | 'held' | 'replied' | 'failed';

export interface CachedSession {
  parentID: string | null | undefined;
  directory: PermissionDirectory;
}

export interface PermissionRequestHeaders {
  Accept: string;
  'Content-Type'?: string;
  'x-opencode-directory'?: string;
}

export type PermissionUiEvent =
  | { type: 'openchamber:permission-auto-accept.updated'; properties: PermissionPolicySnapshot }
  | {
    type: 'openchamber:permission-auto-accept.left-for-user';
    properties: { permissionId: JsonValue; sessionId: JsonValue | undefined; directory: JsonValue };
  };

export interface PermissionAutoAcceptOptions {
  globalEventHub: Pick<GlobalMessageStreamHub, 'subscribeEvent' | 'subscribeStatus'>;
  buildOpenCodeUrl: (path: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  readSettingsFromDiskMigrated: () => Promise<PermissionSettings | null | undefined>;
  persistSettings: (changes: { permissionAutoAccept: PermissionPolicy }) => Promise<PermissionSettings | void>;
  broadcastGlobalUiEvent?: ((event: PermissionUiEvent) => void) | undefined;
  evaluatePermission?: ((permission: RoutingPermission, directory: PermissionDirectory) => Promise<{ action: string } | null | undefined>) | null | undefined;
  onPermissionReplied?: ((permissionId: string) => void) | null | undefined;
  resolveLegacyEnabledMode?: (() => Promise<PermissionMode>) | undefined;
  readDefaultMode?: (() => Promise<JsonValue | undefined>) | undefined;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
  requestTimeoutMs?: number;
}
