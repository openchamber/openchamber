export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type ResetTimestamp = string | number;

export interface UsageWindowInput<Percent = number | null | undefined, Seconds = number | null> {
  usedPercent?: Percent;
  windowSeconds?: Seconds;
  resetAt?: ResetTimestamp | null;
  valueLabel?: string | null | undefined;
  creditsUsed?: number | undefined;
}

export interface UsageWindow<Percent = number | null | undefined, Seconds = number | null> {
  usedPercent: Percent;
  remainingPercent: number | null;
  windowSeconds: Seconds;
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

export interface QuotaResult<ProviderId extends string | null = string, ProviderName extends string | null = string, Usage = ProviderUsage> {
  providerId: ProviderId;
  providerName: ProviderName;
  ok: boolean;
  configured: boolean;
  usage: Usage | null;
  fetchedAt: number;
  error?: string;
  planLabel?: string;
  accountLabel?: string;
}

export interface QuotaResultInput<ProviderId extends string | null = string, ProviderName extends string | null = string, Usage = ProviderUsage> {
  providerId: ProviderId;
  providerName: ProviderName;
  ok: boolean;
  configured: boolean;
  usage?: Usage | null;
  error?: string | null | undefined;
  planLabel?: string | null | undefined;
  accountLabel?: string | null;
}

export interface TokenWindowLimit {
  unit?: unknown;
  number?: unknown;
}
