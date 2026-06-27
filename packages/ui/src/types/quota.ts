export type QuotaProviderId =
  | 'openai'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'github-copilot'
  | 'github-copilot-addon'
  | 'google'
  | 'kimi-for-coding'
  | 'nano-gpt'
  | 'openrouter'
  | 'zai-coding-plan'
  | 'zhipuai-coding-plan'
  | 'minimax-coding-plan'
  | 'minimax-cn-coding-plan'
  | 'ollama-cloud'
  | 'wafer'
  | 'atlascloud'
  | 'byteplus'
  | 'longcat'
  | 'mistral'
  | 'poe'
  | 'qwencloud'
  | 'stepfun'
  | 'xai'
  | 'opencode-go';

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  resetText?: string;
  valueLabel?: string | null;
  suffix?: string;
  detail?: string[];
  extra?: string[];
  warn?: string;
  sectionHeader?: string;
  trendKey?: string;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

/**
 * Per-account sub-card. Mirrors the rich ProviderUsage shape so providers
 * can emit multi-account cards. All fields optional except `windows`.
 */
export interface ProviderAccountUsage {
  accountKey?: string;
  label?: string;
  subtitle?: string;
  note?: string;
  header?: string[];
  windows?: Record<string, UsageWindow>;
  footer?: string[];
  models?: Record<string, UsageWindows>;
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
  subtitle?: string;
  note?: string;
  header?: string[];
  footer?: string[];
  accounts?: ProviderAccountUsage[];
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  usage: ProviderUsage | null;
  fetchedAt: number;
  isStale?: boolean;
  cachedAt?: number;
  accountKey?: string;
}

export type QuotaCredentialValidationStatus = 'untested' | 'valid' | 'expired' | 'invalid';

/**
 * A stored credential record, as returned by list/get endpoints.
 *
 * The raw `credential` field is NEVER present in this type — it is
 * stripped server-side by the sanitize function.
 */
export interface QuotaCredentialRecord {
  id: string;
  providerId: QuotaProviderId;
  label: string;
  accountHint?: string | null;
  createdAt: number;
  updatedAt: number;
  validationStatus: QuotaCredentialValidationStatus;
  lastValidatedAt?: number | null;
  expiry?: number | null;
}

/**
 * Payload for creating a new credential.
 *
 * The `credential` object contains the raw secret and is accepted
 * on POST but never returned in responses.
 */
export interface QuotaCredentialCreate {
  providerId: QuotaProviderId;
  label: string;
  accountHint?: string;
  credential: Record<string, unknown>;
}

export interface QuotaCredentialUpdate {
  label?: string;
  accountHint?: string;
  credential?: Record<string, unknown>;
}

export interface QuotaCredentialValidationResult {
  valid: boolean;
  error?: string;
}
