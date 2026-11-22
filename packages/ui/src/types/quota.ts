type BuiltInQuotaProviderId =
   'openai'
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
  | 'opencode'
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

export type ExtensionQuotaProviderId = `ext-${string}`;

export type QuotaProviderId = BuiltInQuotaProviderId | ExtensionQuotaProviderId;

export interface UsageWindowGiftReset {
  recordId: number;
  expireAt: number;
  grantType?: string;
}

export type UsageWindowValue =
  | { kind: 'requests'; count: number }
  | { kind: 'spend'; spent: number | null; limit: number | null };

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  value?: UsageWindowValue;
  creditsUsed?: number;
  giftReset?: UsageWindowGiftReset | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

export interface ConsoleBudget {
  id: string;
  limit: number;
  spent: number;
  usedPercent: number;
  reached: boolean;
  resetsAt: number;
  sharing: 'you' | 'everyone' | 'group';
  perModel: boolean;
  kind: 'all' | 'vendors' | 'price' | 'models' | 'each';
  vendors: string[];
  models: string[];
  inputPriceAtLeast: number | null;
}

export interface ConsoleBudgets {
  workspace: string | null;
  budgets: ConsoleBudget[];
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
  usageAvailability?: 'console-only';
  consoleBudgets?: ConsoleBudgets;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  planLabel?: string | null;
  /** Per-credential identity, present when the provider holds several stored credentials. */
  credentialId?: string;
  credentialLabel?: string;
  credentialActive?: boolean;
  /**
   * The provider's plan is walled (a 402-class quota-exhausted state), which is
   * distinct from a read failure (`ok: false` without this flag). A consumer
   * that parks work on walls reads this, never the bare `ok`.
   */
  quotaExhausted?: boolean;
  /** When the walled window resets, in epoch milliseconds, when the provider says. */
  quotaResetAt?: number | null;
  accountLabel?: string | null;
  selection?: string;
  usage: ProviderUsage | null;
  fetchedAt: number;
}
