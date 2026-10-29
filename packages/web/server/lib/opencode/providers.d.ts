import type { ProviderEntity, ProviderModelEntity } from './config-v2.js';

/** A custom provider as Settings saves it, in v2 shape. */
export interface CustomProviderConfig {
  package: string;
  name: string;
  settings: { baseURL: string };
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
