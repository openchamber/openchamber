/**
 * Quota Providers Registry
 *
 * Implements quota fetching for various AI providers using a registry pattern.
 * @module quota/providers
 */

import { buildResult } from '../utils/index.js';

import * as claude from './claude.js';
import * as codex from './codex.js';
import * as copilot from './copilot.js';
import * as cursor from './cursor.js';
import * as google from './google/index.js';
import * as kimi from './kimi.js';
import * as nanogpt from './nanogpt.js';
import * as openai from './openai.js';
import * as openrouter from './openrouter.js';
import * as zai from './zai.js';
import * as zhipuaiCodingPlan from './zhipuai-coding-plan.js';
import * as minimaxCodingPlan from './minimax-coding-plan.js';
import * as minimaxCnCodingPlan from './minimax-cn-coding-plan.js';
import * as ollamaCloud from './ollama-cloud.js';
import * as wafer from './wafer.js';
import * as opencodeGo from './opencode-go.js';

const registry = {
  claude: {
    providerId: claude.providerId,
    providerName: claude.providerName,
    isConfigured: claude.isConfigured,
    fetchQuota: claude.fetchQuota,
    login: claude.login
  },
  codex: {
    providerId: codex.providerId,
    providerName: codex.providerName,
    isConfigured: codex.isConfigured,
    fetchQuota: codex.fetchQuota,
    login: codex.login
  },
  cursor: {
    providerId: cursor.providerId,
    providerName: cursor.providerName,
    isConfigured: cursor.isConfigured,
    fetchQuota: cursor.fetchQuota,
    login: cursor.login
  },
  google: {
    providerId: 'google',
    providerName: 'Google',
    isConfigured: () => google.resolveGoogleAuthSources().length > 0,
    fetchQuota: google.fetchGoogleQuota,
    login: google.login
  },
  'zai-coding-plan': {
    providerId: zai.providerId,
    providerName: zai.providerName,
    isConfigured: zai.isConfigured,
    fetchQuota: zai.fetchQuota,
    login: zai.login
  },
  'zhipuai-coding-plan': {
    providerId: zhipuaiCodingPlan.providerId,
    providerName: zhipuaiCodingPlan.providerName,
    isConfigured: zhipuaiCodingPlan.isConfigured,
    fetchQuota: zhipuaiCodingPlan.fetchQuota,
    login: zhipuaiCodingPlan.login
  },
  'kimi-for-coding': {
    providerId: kimi.providerId,
    providerName: kimi.providerName,
    isConfigured: kimi.isConfigured,
    fetchQuota: kimi.fetchQuota,
    login: kimi.login
  },
  openrouter: {
    providerId: openrouter.providerId,
    providerName: openrouter.providerName,
    isConfigured: openrouter.isConfigured,
    fetchQuota: openrouter.fetchQuota,
    login: openrouter.login
  },
  'nano-gpt': {
    providerId: nanogpt.providerId,
    providerName: nanogpt.providerName,
    isConfigured: nanogpt.isConfigured,
    fetchQuota: nanogpt.fetchQuota,
    login: nanogpt.login
  },
  'github-copilot': {
    providerId: copilot.providerId,
    providerName: copilot.providerName,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuota,
    login: copilot.login
  },
  'github-copilot-addon': {
    providerId: copilot.providerIdAddon,
    providerName: copilot.providerNameAddon,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuotaAddon,
    login: copilot.login
  },
  'minimax-coding-plan': {
    providerId: minimaxCodingPlan.providerId,
    providerName: minimaxCodingPlan.providerName,
    isConfigured: minimaxCodingPlan.isConfigured,
    fetchQuota: minimaxCodingPlan.fetchQuota,
    login: minimaxCodingPlan.login
  },
  'minimax-cn-coding-plan': {
    providerId: minimaxCnCodingPlan.providerId,
    providerName: minimaxCnCodingPlan.providerName,
    isConfigured: minimaxCnCodingPlan.isConfigured,
    fetchQuota: minimaxCnCodingPlan.fetchQuota,
    login: minimaxCnCodingPlan.login
  },
  'ollama-cloud': {
    providerId: ollamaCloud.providerId,
    providerName: ollamaCloud.providerName,
    isConfigured: ollamaCloud.isConfigured,
    fetchQuota: ollamaCloud.fetchQuota,
    login: ollamaCloud.login
  },
  wafer: {
    providerId: wafer.providerId,
    providerName: wafer.providerName,
    isConfigured: wafer.isConfigured,
    fetchQuota: wafer.fetchQuota,
    login: wafer.login
  },
  'opencode-go': {
    providerId: opencodeGo.providerId,
    providerName: opencodeGo.providerName,
    isConfigured: opencodeGo.isConfigured,
    fetchQuota: opencodeGo.fetchQuota,
    login: opencodeGo.login,
  }
};

export const listConfiguredQuotaProviders = () => {
  const configured = [];

  for (const [id, provider] of Object.entries(registry)) {
    try {
      if (provider.isConfigured()) {
        configured.push(id);
      }
    } catch {
      // Ignore provider-specific config errors in list API.
    }
  }

  return configured;
};

export const fetchQuotaForProvider = async (providerId) => {
  const provider = registry[providerId];

  if (!provider) {
    return buildResult({
      providerId,
      providerName: providerId,
      ok: false,
      configured: false,
      error: 'Unsupported provider'
    });
  }

  try {
    return await provider.fetchQuota();
  } catch (error) {
    return buildResult({
      providerId: provider.providerId,
      providerName: provider.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const fetchClaudeQuota = claude.fetchQuota;
export const fetchOpenaiQuota = openai.fetchQuota;
export const fetchGoogleQuota = google.fetchGoogleQuota;
export const fetchCodexQuota = codex.fetchQuota;
export const fetchCursorQuota = cursor.fetchQuota;
export const fetchCopilotQuota = copilot.fetchQuota;
export const fetchCopilotAddonQuota = copilot.fetchQuotaAddon;
export const fetchKimiQuota = kimi.fetchQuota;
export const fetchOpenRouterQuota = openrouter.fetchQuota;
export const fetchZaiQuota = zai.fetchQuota;
export const fetchZhipuaiCodingPlanQuota = zhipuaiCodingPlan.fetchQuota;
export const fetchNanoGptQuota = nanogpt.fetchQuota;
export const fetchMinimaxCodingPlanQuota = minimaxCodingPlan.fetchQuota;
export const fetchMinimaxCnCodingPlanQuota = minimaxCnCodingPlan.fetchQuota;
export const fetchOllamaCloudQuota = ollamaCloud.fetchQuota;
export const fetchWaferQuota = wafer.fetchQuota;
export const fetchOpencodeGoQuota = opencodeGo.fetchQuota;
export const fetchZhipuaiQuota = zhipuaiCodingPlan.fetchQuota;