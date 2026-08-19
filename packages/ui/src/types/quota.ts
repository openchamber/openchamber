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
  | 'xai';

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
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
  fetchedAt: number;
}
