// MiniMax Coding Plan Provider
import { createMiniMaxCodingPlanProvider } from './minimax-shared.js';

const provider = createMiniMaxCodingPlanProvider({
  providerId: 'minimax-coding-plan',
  providerName: 'MiniMax Coding Plan (minimax.io)',
  aliases: ['minimax-coding-plan'],
  endpoint: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
});

export const providerId = provider.providerId;
export const providerName = provider.providerName;
export const aliases = provider.aliases;
export const isConfigured = provider.isConfigured;
export const fetchQuota = provider.fetchQuota;
