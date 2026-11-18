import type { ProviderEntity, ProviderModelEntity } from './config-v2.js';
import type { JsonValue } from '../shared/json-values.js';

export function getProviderSources(providerId: string, workingDirectory: string | null): {
  sources: {
    auth: { exists: boolean };
    user: { exists: boolean; path: string };
    project: { exists: boolean; path: string | null };
    custom: { exists: boolean; path: string | null };
  };
  config: ProviderEntity | null;
};
export function readDisabledProviders(workingDirectory: string | null): string[];
export function setProviderDisabled(providerId: string | undefined, disabled: boolean, workingDirectory: string | null): JsonValue[];
export function removeProviderConfig(providerId: string, workingDirectory: string | null, scope?: string): boolean;
export function upsertProviderConfig(
  providerId: string,
  config: Parameters<typeof validateCustomProviderConfig>[1],
  workingDirectory: string | null,
  scope?: string,
  options?: { hasStoredAuth?: boolean },
): { providerId: string; path: string; config: ProviderEntity };

export interface CustomProviderConfig {
  package: string;
  name: string;
  settings: { baseURL: string; tls?: { cert: string; key: string; passphrase?: string } | null };
  headers?: Record<string, string>;
  models: Record<string, ProviderModelEntity & { modelID: string; name: string }>;
  env?: string[];
}

export function validateCustomProviderConfig(
  providerId: string,
  config: unknown,
  options?: { hasStoredAuth?: boolean },
):
  | { ok: false; error: string }
  | { ok: true; value: { providerId: string; config: CustomProviderConfig } };

export function mergeCustomProviderConfig(existingValue: unknown, normalizedConfig: CustomProviderConfig): ProviderEntity;
