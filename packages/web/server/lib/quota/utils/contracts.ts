export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type ResetTimestamp = string | number;

type UsageWindowValue =
  | { kind: 'requests'; count: number }
  | { kind: 'spend'; spent: number | null; limit: number | null };

export interface UsageWindowInput<Percent = number | null | undefined, Seconds = number | null> {
  usedPercent?: Percent;
  windowSeconds?: Seconds;
  resetAt?: ResetTimestamp | null;
  valueLabel?: string | null | undefined;
  value?: UsageWindowValue | undefined;
  creditsUsed?: number | undefined;
  credits?: UsageWindowCredits | undefined;
}

export interface UsageWindowCredits {
  used: number;
  limit: number;
  remaining?: number;
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
  value?: UsageWindowValue;
  creditsUsed?: number;
  credits?: UsageWindowCredits;
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
  selection?: string;
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
