import type { OpenCode } from '@opencode/client';
import type { JsonValue } from '../shared/json-values.js';
import type { CustomEndpoint, RoutingCategory, RoutingConfig, createRoutingStore } from './store.js';
import type { readPinnedCustomEndpoint } from './classifier.js';
import type { RoutingHistory } from './history.js';
import type { createJevClient } from './jev.js';
import type { RoutingPermission } from './jev.js';

export interface SessionScope {
  sessionId: string;
  directory?: string | null | undefined;
}

export interface RoutingModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export type RoutingBody = JsonValue | undefined;

export interface CustomEndpointInput {
  url: JsonValue | undefined;
  model: JsonValue | undefined;
  key?: JsonValue | undefined;
}

export interface AutoSelectionInput extends SessionScope {
  model: RoutingModelRef | { providerID: string; modelID: string } | null | undefined;
  agent?: string | null | undefined;
  requestText?: string;
}

export interface Selection {
  model: RoutingModelRef;
  decision: {
    providerID: string;
    modelID: string;
    variant: string | null;
    agent: string | null;
  };
}

export interface RoutingAttempt {
  sessionId: string;
  at: number;
  category: string | null;
  confidence: number;
  reason: string;
  ms: number;
  cacheHold?: { requested: string };
  error?: string;
}

export type RoutingBroadcastProperties = (RoutingAttempt & Selection['decision'])
  | { available: boolean; autoReady: boolean; jevAvailable: boolean; tokenPresent: boolean; jevSource: string }
  | { permissionId: RoutingPermission['id']; sessionId: RoutingPermission['sessionID']; directory: JsonValue; error: string }
  | { permissionId: RoutingPermission['id']; sessionId: RoutingPermission['sessionID']; directory: JsonValue; score: number; kind: string | null };

export interface PermissionVerdict {
  action: 'hold' | 'accept';
  score: number;
  kind: string | null;
}

export interface CacheHoldInput extends SessionScope {
  config: RoutingConfig;
  fallback: NonNullable<RoutingConfig['fallback']>;
  chosen: RoutingCategory | null;
  composerAgent: string | null | undefined;
  lastAnswer: RoutingHistory['lastAnswer'];
}

type Client = ReturnType<typeof OpenCode.make>;
export interface ProviderKeys {
  zenKey: string | null;
  openrouterKey: string | null;
  vercelKey: string | null;
  geminiKey: string | null;
}

export interface RoutingRuntimeOptions {
  dataDir: string;
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  broadcastGlobalUiEvent?: (event: { type: string; properties: RoutingBroadcastProperties }) => void;
  fetchImpl?: typeof fetch;
  store?: ReturnType<typeof createRoutingStore>;
  jev?: ReturnType<typeof createJevClient>;
  readProviderKeys?: () => ProviderKeys | Promise<ProviderKeys>;
  zenPromotionActive?: boolean;
  enterpriseMode?: () => boolean;
  readPinnedEndpoint?: typeof readPinnedCustomEndpoint;
  listCatalogModels?: ((directory: SessionScope['directory']) => Promise<{ providerID: string; modelID: string; variants: { id: string }[] }[]>) | null;
  readSessionHistory?: ((scope: SessionScope) => Promise<RoutingHistory>) | null;
  readConfigEntries?: ((directory: SessionScope['directory']) => ReturnType<Client['config']['get']>) | null;
  readSessionAgent?: ((scope: SessionScope) => Promise<string | null>) | null;
  isSessionWarm?: (sessionId: string, cacheLifetimeMs: number) => boolean;
  now?: () => number;
}

export interface PublicCustomEndpoint extends Pick<CustomEndpoint, 'url' | 'model'> {
  keyPresent: boolean;
  pinned: boolean;
}
