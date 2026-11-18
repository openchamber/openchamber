import type { OpenCode, SessionFormReplyInput } from '@opencode/client';
import type { CustomEndpoint, RoutingCategory, RoutingConfig, createRoutingStore } from './store.js';
import type { readPinnedCustomEndpoint } from './classifier.js';
import type { RoutingHistory } from './history.js';
import type { createJevClient } from './jev.js';

export interface SessionScope {
  sessionId: string;
  directory?: string | null | undefined;
}

export interface RoutingModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface RoutingBody {
  text?: string | null;
  name?: string;
  answer?: SessionFormReplyInput['answer'];
  files?: { uri?: string | null; name?: string | null }[];
  agent?: string;
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
  | { permissionId: string; sessionId: string; directory: string | null; error: string }
  | { permissionId: string; sessionId: string; directory: string | null; score: number; kind: string | null };

export interface PermissionVerdict {
  action: 'hold' | 'accept';
  score: number;
  kind: string | null;
}

export interface CacheHoldInput extends SessionScope {
  config: RoutingConfig;
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
