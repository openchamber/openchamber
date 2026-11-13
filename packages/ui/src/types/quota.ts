export type QuotaProviderId =
  | 'openai'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'cline-pass'
  | 'github-copilot'
  | 'github-copilot-addon'
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
  | 'neuralwatt'
  | 'kilo'
  | 'zenmux'
  | 'xai';

export interface UsageWindowGiftReset {
  recordId: number;
  expireAt: number;
}

export type UsageWindowValue =
  | { kind: 'requests'; count: number }
  | { kind: 'spend'; spent: number; limit: number | null };

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
  /** Claimable gift (bonus) limit reset, when the provider exposes an available one. */
  giftReset?: UsageWindowGiftReset | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

/** One OpenCode Console budget: a monthly spend limit the workspace sets on the member. */
export interface ConsoleBudget {
  id: string;
  limit: number;
  spent: number;
  usedPercent: number;
  reached: boolean;
  resetsAt: number;
  /** Who spends against it: the member alone, everyone in the workspace, or a group of members. */
  sharing: 'you' | 'everyone' | 'group';
  /** The limit applies to each model on its own. */
  perModel: boolean;
  /** What it counts: all spend, a vendor's models, models from an input price, picked models, or each model. */
  kind: 'all' | 'vendors' | 'price' | 'models' | 'each';
  vendors: string[];
  models: string[];
  /** USD per 1M input tokens from which it counts a model. */
  inputPriceAtLeast: number | null;
}

export interface ConsoleBudgets {
  workspace: string | null;
  budgets: ConsoleBudget[];
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
  /** OpenCode Go only: the Console budgets of the same sign-in, shown on its usage page. */
  consoleBudgets?: ConsoleBudgets;
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
