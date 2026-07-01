/**
 * Quota Providers Registry
 *
 * Implements quota fetching for various AI providers using a registry pattern.
 * @module quota/providers
 */

import { buildResult } from '../utils/index.js';

import * as atlascloud from './atlascloud.js';
import * as byteplus from './byteplus.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as copilot from './copilot.js';
import * as cursor from './cursor.js';
import * as google from './google/index.js';
import * as kimi from './kimi.js';
import * as longcat from './longcat.js';
import * as mistral from './mistral.js';
import * as nanogpt from './nanogpt.js';
import * as openai from './openai.js';
import * as opencodeGo from './opencode-go.js';
import * as openrouter from './openrouter.js';
import * as poe from './poe.js';
import * as qwencloud from './qwencloud.js';
import * as stepfun from './stepfun.js';
import * as xai from './xai.js';
import * as zai from './zai.js';
import * as zhipuaiCodingPlan from './zhipuai-coding-plan.js';
import * as minimaxCodingPlan from './minimax-coding-plan.js';
import * as minimaxCnCodingPlan from './minimax-cn-coding-plan.js';
import * as ollamaCloud from './ollama-cloud.js';
import * as wafer from './wafer.js';

const registry = {
  atlascloud: {
    providerId: atlascloud.providerId,
    providerName: atlascloud.providerName,
    isConfigured: atlascloud.isConfigured,
    fetchQuota: atlascloud.fetchQuota
  },
  byteplus: {
    providerId: byteplus.providerId,
    providerName: byteplus.providerName,
    isConfigured: byteplus.isConfigured,
    fetchQuota: byteplus.fetchQuota
  },
  claude: {
    providerId: claude.providerId,
    providerName: claude.providerName,
    isConfigured: claude.isConfigured,
    fetchQuota: claude.fetchQuota
  },
  codex: {
    providerId: codex.providerId,
    providerName: codex.providerName,
    isConfigured: codex.isConfigured,
    fetchQuota: codex.fetchQuota
  },
  cursor: {
    providerId: cursor.providerId,
    providerName: cursor.providerName,
    isConfigured: cursor.isConfigured,
    fetchQuota: cursor.fetchQuota
  },
  google: {
    providerId: google.providerId,
    providerName: google.providerName,
    isConfigured: google.isConfigured,
    fetchQuota: google.fetchGoogleQuota
  },
  longcat: {
    providerId: longcat.providerId,
    providerName: longcat.providerName,
    isConfigured: longcat.isConfigured,
    fetchQuota: longcat.fetchQuota
  },
  mistral: {
    providerId: mistral.providerId,
    providerName: mistral.providerName,
    isConfigured: mistral.isConfigured,
    fetchQuota: mistral.fetchQuota
  },
  'opencode-go': {
    providerId: opencodeGo.providerId,
    providerName: opencodeGo.providerName,
    isConfigured: opencodeGo.isConfigured,
    fetchQuota: opencodeGo.fetchQuota
  },
  poe: {
    providerId: poe.providerId,
    providerName: poe.providerName,
    isConfigured: poe.isConfigured,
    fetchQuota: poe.fetchQuota
  },
  qwencloud: {
    providerId: qwencloud.providerId,
    providerName: qwencloud.providerName,
    isConfigured: qwencloud.isConfigured,
    fetchQuota: qwencloud.fetchQuota
  },
  stepfun: {
    providerId: stepfun.providerId,
    providerName: stepfun.providerName,
    isConfigured: stepfun.isConfigured,
    fetchQuota: stepfun.fetchQuota
  },
  xai: {
    providerId: xai.providerId,
    providerName: xai.providerName,
    isConfigured: xai.isConfigured,
    fetchQuota: xai.fetchQuota
  },
  'zai-coding-plan': {
    providerId: zai.providerId,
    providerName: zai.providerName,
    isConfigured: zai.isConfigured,
    fetchQuota: zai.fetchQuota
  },
  'zhipuai-coding-plan': {
    providerId: zhipuaiCodingPlan.providerId,
    providerName: zhipuaiCodingPlan.providerName,
    isConfigured: zhipuaiCodingPlan.isConfigured,
    fetchQuota: zhipuaiCodingPlan.fetchQuota
  },
  'kimi-for-coding': {
    providerId: kimi.providerId,
    providerName: kimi.providerName,
    isConfigured: kimi.isConfigured,
    fetchQuota: kimi.fetchQuota
  },
  openrouter: {
    providerId: openrouter.providerId,
    providerName: openrouter.providerName,
    isConfigured: openrouter.isConfigured,
    fetchQuota: openrouter.fetchQuota
  },
  'nano-gpt': {
    providerId: nanogpt.providerId,
    providerName: nanogpt.providerName,
    isConfigured: nanogpt.isConfigured,
    fetchQuota: nanogpt.fetchQuota
  },
  'github-copilot': {
    providerId: copilot.providerId,
    providerName: copilot.providerName,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuota
  },
  'github-copilot-addon': {
    providerId: copilot.providerIdAddon,
    providerName: copilot.providerNameAddon,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuotaAddon
  },
  'minimax-coding-plan': {
    providerId: minimaxCodingPlan.providerId,
    providerName: minimaxCodingPlan.providerName,
    isConfigured: minimaxCodingPlan.isConfigured,
    fetchQuota: minimaxCodingPlan.fetchQuota
  },
  'minimax-cn-coding-plan': {
    providerId: minimaxCnCodingPlan.providerId,
    providerName: minimaxCnCodingPlan.providerName,
    isConfigured: minimaxCnCodingPlan.isConfigured,
    fetchQuota: minimaxCnCodingPlan.fetchQuota
  },
  'ollama-cloud': {
    providerId: ollamaCloud.providerId,
    providerName: ollamaCloud.providerName,
    isConfigured: ollamaCloud.isConfigured,
    fetchQuota: ollamaCloud.fetchQuota
  },
  wafer: {
    providerId: wafer.providerId,
    providerName: wafer.providerName,
    isConfigured: wafer.isConfigured,
    fetchQuota: wafer.fetchQuota
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
const fetchZhipuaiCodingPlanQuota = zhipuaiCodingPlan.fetchQuota;
export const fetchNanoGptQuota = nanogpt.fetchQuota;
export const fetchMinimaxCodingPlanQuota = minimaxCodingPlan.fetchQuota;
export const fetchMinimaxCnCodingPlanQuota = minimaxCnCodingPlan.fetchQuota;
export const fetchOllamaCloudQuota = ollamaCloud.fetchQuota;
export const fetchWaferQuota = wafer.fetchQuota;
export const fetchZhipuaiQuota = zhipuaiCodingPlan.fetchQuota;
export const fetchAtlascloudQuota = atlascloud.fetchQuota;
export const fetchByteplusQuota = byteplus.fetchQuota;
export const fetchLongcatQuota = longcat.fetchQuota;
export const fetchMistralQuota = mistral.fetchQuota;
export const fetchOpencodeGoQuota = opencodeGo.fetchQuota;
export const fetchPoeQuota = poe.fetchQuota;
export const fetchQwencloudQuota = qwencloud.fetchQuota;
export const fetchStepfunQuota = stepfun.fetchQuota;
export const fetchXaiQuota = xai.fetchQuota;

