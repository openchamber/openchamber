export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type ResetTimestamp = string | number;

export interface UsageWindowInput {
  usedPercent?: number | null | undefined;
  windowSeconds?: number | null;
  resetAt?: ResetTimestamp | null;
  valueLabel?: string | null | undefined;
  creditsUsed?: number | undefined;
}

export interface UsageWindow {
  usedPercent: number | null | undefined;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: ResetTimestamp | null | undefined;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
  creditsUsed?: number;
}

export interface ProviderUsage {
  windows: Record<string, UsageWindow>;
  models?: Record<string, ProviderUsage> | undefined;
}

export interface QuotaResult<ProviderId extends string | null = string, ProviderName extends string | null = string> {
  providerId: ProviderId;
  providerName: ProviderName;
  ok: boolean;
  configured: boolean;
  usage: ProviderUsage | null;
  fetchedAt: number;
  error?: string;
  planLabel?: string;
  accountLabel?: string;
}

export interface QuotaResultInput<ProviderId extends string | null = string, ProviderName extends string | null = string> {
  providerId: ProviderId;
  providerName: ProviderName;
  ok: boolean;
  configured: boolean;
  usage?: ProviderUsage | null;
  error?: string | null | undefined;
  planLabel?: string | null | undefined;
  accountLabel?: string | null;
}

export interface TokenWindowLimit {
  unit?: number | string;
  number?: number;
}

export interface TokenWindowDurations {
  readonly [unit: string]: number | undefined;
}
