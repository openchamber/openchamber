import type { QuotaProviderId } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
];

export const QUOTA_PROVIDER_MAP = QUOTA_PROVIDERS.reduce<
  Record<string, QuotaProviderMeta>
>((acc, provider) => {
  acc[provider.id] = provider;
  return acc;
}, {});
