import {
  GEMINI_DECISIONS_API_URL,
  GEMINI_DECISIONS_MODEL,
  JEV_API_URL,
  JEV_MODEL,
  OPENROUTER_JEV_API_URL,
  OPENROUTER_JEV_MODEL,
  VERCEL_JEV_API_URL,
  VERCEL_JEV_MODEL,
  ZEN_CLIENT_ID,
  ZEN_JEV_API_URL,
  ZEN_JEV_MODEL,
  ZEN_JEV_PAID_MODEL,
} from './defaults.js';
import { readEnterprisePolicy } from '../enterprise-mode.js';
import type { EnterprisePolicyOptions } from '../enterprise-mode.js';
import type { CustomEndpoint } from './store.js';
import { OPENAI_DECISIONS_MODEL, OPENAI_DECISIONS_URL, type OpenAIDecisionsEndpoint } from './openai-decisions.js';

export const CLASSIFIER_SOURCES = ['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'gemini', 'openai-decisions', 'typesafe', 'custom'] as const;
export type ClassifierSource = typeof CLASSIFIER_SOURCES[number];
export interface ClassifierKeys {
  typesafeKey?: string | null;
  zenKey?: string | null;
  openrouterKey?: string | null;
  vercelKey?: string | null;
  geminiKey?: string | null;
  openaiKey?: string | null;
  customEndpoint?: CustomEndpoint | null;
}
export interface Classifier {
  selected: ClassifierSource;
  effective: Exclude<ClassifierSource, 'off'> | null;
  sources: { id: ClassifierSource; usable: boolean }[];
}
interface JevEndpoint {
  url: string;
  model: string;
  headers: Record<string, string>;
  format?: 'gemini';
}
export type ClassifierEndpoint = JevEndpoint | OpenAIDecisionsEndpoint;
const FALLBACK_ORDER: Exclude<ClassifierSource, 'off'>[] = ['typesafe', 'custom', 'openrouter', 'vercel', 'zen-key'];

export const parseCustomEndpointUrl = (input: string | null | undefined) => {
  const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw invalid('Enter a full http:// or https:// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Only http:// and https:// URLs are supported');
  if (url.username || url.password) throw invalid('Put the key in the API key field, not in the URL');
  url.hash = '';
  return url.toString();
};

let warnedInvalidPin = false;

export const readPinnedCustomEndpoint = (options?: EnterprisePolicyOptions): CustomEndpoint | null => {
  const pinned = readEnterprisePolicy(options).jev;
  if (!pinned) return null;
  let url;
  try {
    url = parseCustomEndpointUrl(pinned.url);
  } catch (error) {
    if (!warnedInvalidPin) console.warn('[routing] the pinned Jev endpoint is ignored:', error instanceof Error ? error.message : undefined);
    warnedInvalidPin = true;
    return null;
  }
  const model = pinned.model || JEV_MODEL;
  return pinned.apiKey ? { url, model, key: pinned.apiKey } : { url, model };
};

const LEGACY_SOURCES: ClassifierSource[] = ['zen-promo', 'zen-key', 'typesafe'];

export const resolveClassifier = ({ selected, typesafeKey, zenKey, openrouterKey, vercelKey, geminiKey, openaiKey, customEndpoint, zenPromotionActive }: ClassifierKeys & { selected: ClassifierSource | null; zenPromotionActive: boolean }): Classifier => {
  const chosen = selected ?? (typesafeKey ? 'typesafe' : 'off');
  const usable = {
    off: true,
    'zen-promo': Boolean(zenPromotionActive),
    'zen-key': Boolean(zenKey),
    openrouter: Boolean(openrouterKey),
    vercel: Boolean(vercelKey),
    gemini: Boolean(geminiKey),
    'openai-decisions': Boolean(openaiKey),
    typesafe: Boolean(typesafeKey),
    custom: Boolean(customEndpoint),
  };
  const effective = chosen === 'off'
    ? null
    : usable[chosen] ? chosen : FALLBACK_ORDER.find((source) => usable[source]) ?? null;
  return {
    selected: chosen,
    effective,
    sources: CLASSIFIER_SOURCES.map((id) => ({ id, usable: usable[id] })),
  };
};

export const legacyClassifier = (classifier: Classifier) => {
  const legacy = (source: ClassifierSource | null) => source === null || LEGACY_SOURCES.includes(source);
  if (!legacy(classifier.selected) || !legacy(classifier.effective)) return null;
  return { ...classifier, sources: classifier.sources.filter((source) => LEGACY_SOURCES.includes(source.id)) };
};

export const classifierEndpoint = (...args:
  | [source: 'custom', keys: ClassifierKeys & { customEndpoint: CustomEndpoint }]
  | [source: 'gemini', keys: ClassifierKeys & { geminiKey: string }]
  | [source: 'openai-decisions', keys: { openaiKey: string; isAllowed: () => boolean }]
  | [source: Exclude<ClassifierSource, 'custom' | 'gemini' | 'openai-decisions'>, keys: ClassifierKeys]
): ClassifierEndpoint => {
  const [source, keys] = args;
  if (source === 'openai-decisions') {
    return { format: source, url: OPENAI_DECISIONS_URL, model: OPENAI_DECISIONS_MODEL, key: keys.openaiKey, isAllowed: keys.isAllowed };
  }
  if (source === 'custom') {
    const { customEndpoint } = keys;
    const headers: Record<string, string> = {};
    if (customEndpoint.key) headers.authorization = `Bearer ${customEndpoint.key}`;
    return { url: customEndpoint.url, model: customEndpoint.model, headers };
  }
  const { typesafeKey, zenKey, openrouterKey, vercelKey } = keys;
  if (source === 'typesafe') {
    return { url: JEV_API_URL, model: JEV_MODEL, headers: { authorization: `Bearer ${typesafeKey}` } };
  }
  if (source === 'openrouter') {
    return { url: OPENROUTER_JEV_API_URL, model: OPENROUTER_JEV_MODEL, headers: { authorization: `Bearer ${openrouterKey}` } };
  }
  if (source === 'vercel') {
    return { url: VERCEL_JEV_API_URL, model: VERCEL_JEV_MODEL, headers: { authorization: `Bearer ${vercelKey}` } };
  }
  if (source === 'gemini') {
    return { url: GEMINI_DECISIONS_API_URL, model: GEMINI_DECISIONS_MODEL, headers: { 'x-goog-api-key': keys.geminiKey }, format: 'gemini' };
  }
  if (source === 'zen-key') {
    return { url: ZEN_JEV_API_URL, model: ZEN_JEV_PAID_MODEL, headers: { authorization: `Bearer ${zenKey}`, 'x-opencode-client': ZEN_CLIENT_ID } };
  }
  return { url: ZEN_JEV_API_URL, model: ZEN_JEV_MODEL, headers: { 'x-opencode-client': ZEN_CLIENT_ID } };
};
