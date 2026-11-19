import type fs from 'node:fs/promises';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export type StoredNetworkError = { code: string; message: string };
export type StoredNetworkStep = {
  step: string;
  status: string;
  error?: StoredNetworkError;
};
export type StoredHydrationPart = {
  path: string;
  status: string;
  endpoint?: { displayUrl: string; fingerprint: string };
  error?: StoredNetworkError;
};
export type StoredHydration = {
  status: string;
  submodules: StoredHydrationPart[];
  lfs: StoredHydrationPart[];
};
export type StoredRuntimeIdentity = { id: string; platform: string };
export type StoredNetworkSnapshot = {
  operationId: string;
  runtimeIdentity: StoredRuntimeIdentity;
  transport: JsonValue;
  target: JsonObject & { operation: string };
  completedSteps: string[];
  state: string;
  error?: StoredNetworkError;
  stepResults?: StoredNetworkStep[];
  hydration?: StoredHydration;
};
export type NetworkOperationOwner = { pid: number; host: string; instance: string };
export type StoredNetworkRecord = {
  operationId: string;
  runtimeIdentity: StoredRuntimeIdentity;
  repositoryId: string | null;
  targetFingerprints: string[];
  snapshot: StoredNetworkSnapshot;
  state: string;
  completedSteps: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  expiresAt: number | null;
  remotePublicationStarted: boolean;
  localIntegrationStarted: boolean;
  owner?: NetworkOperationOwner;
};
export type NetworkOperationState = {
  version: number;
  records: Record<string, StoredNetworkRecord>;
};
export interface NetworkOperationStoreOptions {
  filePath?: string;
  fsImpl?: typeof fs;
  now?: () => number;
  maxRecords?: number;
  terminalRetentionMs?: number;
  maxBytes?: number;
  lockWaitMs?: number;
}
export interface BuildNetworkRecordInput {
  snapshot: JsonValue | undefined;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  remotePublicationStarted?: boolean;
  localIntegrationStarted?: boolean;
  recordOwner?: NetworkOperationOwner | undefined;
}
