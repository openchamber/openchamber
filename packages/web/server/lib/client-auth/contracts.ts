import type * as fs from 'node:fs/promises';
import type * as path from 'node:path';
import type * as crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface StoreDependencies {
  fsPromises: Pick<typeof fs, 'readFile' | 'mkdir' | 'writeFile'> & Partial<Pick<typeof fs, 'chmod'>>;
  path: Pick<typeof path, 'dirname'>;
  crypto: Pick<typeof crypto, 'createHash' | 'randomBytes' | 'timingSafeEqual'>;
  storePath: string;
}

export interface ClientInput {
  label?: unknown;
  fallbackLabel?: unknown;
  expiresAt?: unknown;
  clientKind?: unknown;
  dedupeKey?: unknown;
  authMethod?: unknown;
  pairingId?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  deviceModel?: unknown;
  appVersion?: unknown;
  usesRelay?: unknown;
  localOnly?: unknown;
}

export interface RemoteClient {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  clientKind: string | null;
  authMethod: string | null;
  pairingId: string | null;
  deviceName: string | null;
  devicePlatform: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  usesRelay: boolean;
  localOnly: boolean;
  lastTransport: 'relay' | 'direct' | null;
}

export interface StoredClient extends Omit<RemoteClient, 'lastTransport'> {
  tokenHash: string;
  dedupeKey: string | null;
  lastTransport?: RemoteClient['lastTransport'];
}

export interface ClientStore {
  version: number;
  clients: StoredClient[];
}

export interface CreatedClient {
  client: RemoteClient;
  token: string;
  replacedClientIds: string[];
}

export interface BearerRequest {
  headers?: IncomingHttpHeaders;
}

export interface PairingInput {
  label?: unknown;
  allowedClientKinds?: unknown;
  createdByClientId?: unknown;
  usesRelay?: unknown;
  localOnly?: unknown;
}

export interface RedemptionInput {
  pairingId?: unknown;
  secret?: unknown;
  clientLabel?: unknown;
  clientKind?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  deviceModel?: unknown;
  appVersion?: unknown;
  dedupeKey?: unknown;
}

export type PairingClientKind = 'mobile' | 'desktop';

export interface PairingSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  clientId: string | null;
  label: string;
  fingerprint: string;
  allowedClientKinds: PairingClientKind[];
  createdByClientId: string | null;
  usesRelay: boolean;
  localOnly: boolean;
}

export interface StoredPairingSession extends Omit<PairingSession, 'label'> {
  label: string | null;
  secretHash: string;
}

export interface PairingStore {
  version: number;
  sessions: StoredPairingSession[];
}

export interface PairingDependencies extends Partial<StoreDependencies> {
  remoteClientAuthRuntime?: {
    createClient: (input: ClientInput) => Promise<CreatedClient>;
  };
  ttlMs?: number;
}

export interface StoredInput extends ClientInput, PairingInput {
  id?: unknown;
  tokenHash?: unknown;
  secretHash?: unknown;
  createdAt?: unknown;
  lastUsedAt?: unknown;
  revokedAt?: unknown;
  lastTransport?: unknown;
  usedAt?: unknown;
  cancelledAt?: unknown;
  clientId?: unknown;
  fingerprint?: unknown;
}

export interface StoreInput {
  clients?: unknown;
  sessions?: unknown;
}
