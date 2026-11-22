export type QuotaProviderId =
  | 'openai'
  | 'codex'
  | 'command-code'
  | 'cursor'
  | 'claude'
  | 'cline-pass'
  | 'github-copilot'
  | 'google'
  | 'antigravity'
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
  | 'deepinfra'
  | 'deepseek'
  | 'exe-dev'
  | 'hyper'
  | 'meta'
  | 'mistral'
  | 'neuralwatt'
  | 'kilo'
  | 'zenmux'
  | 'opendesign'
  | 'xai';

export interface UsageWindowGiftReset {
  recordId: number;
  expireAt: number;
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
  /** Claimable gift (bonus) limit reset, when the provider exposes an available one. */
  giftReset?: UsageWindowGiftReset | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
  usageAvailability?: 'console-only';
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  /** Subscription tier reported by the provider, when it exposes one. */
  planLabel?: string | null;
  /** Per-credential identity, present when the provider holds several stored credentials. */
  credentialId?: string;
  credentialLabel?: string;
  credentialActive?: boolean;
  accountLabel?: string;
  /**
   * The provider's plan is walled (a 402-class quota-exhausted state), which is
   * distinct from a read failure (`ok: false` without this flag). A consumer
   * that parks work on walls reads this, never the bare `ok`.
   */
  quotaExhausted?: boolean;
  /** When the walled window resets, in epoch milliseconds, when the provider says. */
  quotaResetAt?: number | null;
  usage: ProviderUsage | null;
  fetchedAt: number;
}
