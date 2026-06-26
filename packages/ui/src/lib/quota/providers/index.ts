import type { QuotaProviderId } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'wafer', name: 'Wafer.ai' },
];

export const QUOTA_PROVIDER_MAP = QUOTA_PROVIDERS.reduce<
  Record<string, QuotaProviderMeta>
>((acc, provider) => {
  acc[provider.id] = provider;
  return acc;
}, {});

export const getQuotaProviderMeta = (
  providerId: QuotaProviderId | string,
  providerName?: string | null
): QuotaProviderMeta => {
  return QUOTA_PROVIDER_MAP[providerId] ?? {
    id: providerId as QuotaProviderId,
    name: providerName || providerId,
  };
};

export const mergeQuotaProviders = (
  results: Array<{ providerId: QuotaProviderId | string; providerName?: string | null }> = []
): QuotaProviderMeta[] => {
  const providers = [...QUOTA_PROVIDERS];
  const seen = new Set(providers.map((provider) => provider.id));

  for (const result of results) {
    if (seen.has(result.providerId)) {
      continue;
    }
    providers.push(getQuotaProviderMeta(result.providerId, result.providerName));
    seen.add(result.providerId);
  }

  return providers;
};
