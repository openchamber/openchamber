export type QuotaProviderId =
  | 'openai'
  | 'codex'
  | 'command-code'
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
  | 'opencode-go'
  | 'crof'
  | 'deepseek'
  | 'neuralwatt'
  | 'sub2api'
  | 'xai';

export interface UsageStatistics {
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  actualCost: number | null;
}

export interface ProviderUsageStatistics {
  today: UsageStatistics | null;
  total: UsageStatistics | null;
  models: Record<string, UsageStatistics> | null;
  unit: string | null;
}

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  /** Display-mode-aware amount for "used", e.g. "$36.50". Precedes valueLabel when the UI shows used. */
  usedLabel?: string | null;
  /** Display-mode-aware amount for "remaining", e.g. "$63.50". Precedes valueLabel when the UI shows remaining. */
  remainingLabel?: string | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  /** Subscription tier reported by the provider, when it exposes one. */
  planLabel?: string | null;
  usage: ProviderUsage | null;
  /** Provider-reported key state on a successful response, e.g. 'quota_exhausted' | 'expired'. */
  status?: string | null;
  /** Optional aggregate and per-model usage statistics, kept separate from quota windows. */
  statistics?: ProviderUsageStatistics | null;
  fetchedAt: number;
}
