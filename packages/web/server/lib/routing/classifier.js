/**
 * Which service answers Jev requests: the classification provider.
 *
 * - `off`: nothing. Jev sees conversation excerpts, so it is off until the
 *   user picks a source.
 * - `zen-promo`: OpenCode Zen's free promotional model, no credential.
 * - `zen-key`: the paid model on the same endpoint, with a Zen API key the user
 *   saved in OpenCode.
 * - `openrouter`, `vercel`: the same System One API through OpenRouter or
 *   Vercel AI Gateway, with the key the user saved for that provider in
 *   OpenCode.
 * - `typesafe`: TypeSafe's own API with a key saved in OpenChamber.
 * - `custom`: any endpoint that speaks the System One API (a self-hosted
 *   gateway, a company proxy), with the URL, model and optional key saved in
 *   OpenChamber.
 *
 * The user picks one. A pick that cannot be used right now (the promotion
 * ended, the key was removed) falls back to the first usable key, so Jev
 * stays available while the user has one. The promotion needs no credential,
 * so it is never a fallback: only a pick sends anything there. No usable
 * source means no Jev: the safety net and Auto are not offered.
 */
import {
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

export const CLASSIFIER_SOURCES = ['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'typesafe', 'custom'];
// What the user set up in OpenChamber for Jev comes before keys borrowed from OpenCode.
const FALLBACK_ORDER = ['typesafe', 'custom', 'openrouter', 'vercel', 'zen-key'];

const SYSTEM_ONE_PATH = '/systemone';

/**
 * The request URL for a custom endpoint, from what the user pasted: the full
 * `.../v1/systemone` URL as is, an OpenAI-style base URL ending in `/v1`, or
 * an API root the way TypeSafe's SDKs take `baseURL` (`https://api.typesafe.ai`).
 * Only http(s), and no credentials in the URL: the key has its own field and
 * the URL is shown back in Settings. Throws with status 400 otherwise.
 */
export const normalizeCustomEndpointUrl = (input) => {
  const invalid = (message) => Object.assign(new Error(message), { status: 400 });
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw invalid('Enter a full http:// or https:// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Only http:// and https:// URLs are supported');
  if (url.username || url.password) throw invalid('Put the key in the API key field, not in the URL');
  url.hash = '';
  const base = url.pathname.replace(/\/+$/, '');
  if (base.endsWith(SYSTEM_ONE_PATH)) url.pathname = base;
  else if (base.endsWith('/v1')) url.pathname = `${base}${SYSTEM_ONE_PATH}`;
  else url.pathname = `${base}/v1${SYSTEM_ONE_PATH}`;
  return url.toString();
};

let warnedInvalidPin = false;

/**
 * A custom endpoint an administrator pinned: `jev` in the machine policy file,
 * else `OPENCHAMBER_JEV_URL` (any form `normalizeCustomEndpointUrl` accepts),
 * `OPENCHAMBER_JEV_MODEL` (default `jev-latest`) and an optional
 * `OPENCHAMBER_JEV_API_KEY` (see ../enterprise-mode.js). It replaces the one
 * saved in Settings, which then cannot be edited, and it is the one Jev source
 * enterprise mode allows. Null when unset or not a valid URL.
 */
export const readPinnedCustomEndpoint = (options) => {
  const pinned = readEnterprisePolicy(options).jev;
  if (!pinned) return null;
  let url;
  try {
    url = normalizeCustomEndpointUrl(pinned.url);
  } catch (error) {
    if (!warnedInvalidPin) console.warn('[routing] the pinned Jev endpoint is ignored:', error.message);
    warnedInvalidPin = true;
    return null;
  }
  const model = pinned.model || JEV_MODEL;
  return pinned.apiKey ? { url, model, key: pinned.apiKey } : { url, model };
};

/** The sources clients from v2.0.2 parse; any other id fails their whole routing state. */
const LEGACY_SOURCES = ['zen-promo', 'zen-key', 'typesafe'];

/**
 * `selected` is the stored pick or null. Before the pick existed a saved
 * TypeSafe key always won, so that stays the default when one is present;
 * otherwise nothing is sent anywhere until the user picks.
 */
export const resolveClassifier = ({ selected, typesafeKey, zenKey, openrouterKey, vercelKey, customEndpoint, zenPromotionActive }) => {
  const chosen = selected ?? (typesafeKey ? 'typesafe' : 'off');
  const usable = {
    off: true,
    'zen-promo': Boolean(zenPromotionActive),
    'zen-key': Boolean(zenKey),
    openrouter: Boolean(openrouterKey),
    vercel: Boolean(vercelKey),
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

/**
 * `classifier` as clients from v2.0.2 read it: their schema knows only the
 * first three sources and rejects the whole routing state on any other id,
 * which would hide Auto and the safety net on an older phone app connected to
 * a newer server. With Off, OpenRouter, Vercel or a custom endpoint in play they get null and
 * show the provider page as unavailable; the features keep working.
 */
export const legacyClassifier = (classifier) => {
  const legacy = (source) => source === null || LEGACY_SOURCES.includes(source);
  if (!legacy(classifier.selected) || !legacy(classifier.effective)) return null;
  return { ...classifier, sources: classifier.sources.filter((source) => LEGACY_SOURCES.includes(source.id)) };
};

/** The request target for a usable source. */
export const classifierEndpoint = (source, { typesafeKey, zenKey, openrouterKey, vercelKey, customEndpoint }) => {
  if (source === 'custom') {
    const headers = {};
    if (customEndpoint.key) headers.authorization = `Bearer ${customEndpoint.key}`;
    return { url: customEndpoint.url, model: customEndpoint.model, headers };
  }
  if (source === 'typesafe') {
    return { url: JEV_API_URL, model: JEV_MODEL, headers: { authorization: `Bearer ${typesafeKey}` } };
  }
  if (source === 'openrouter') {
    return { url: OPENROUTER_JEV_API_URL, model: OPENROUTER_JEV_MODEL, headers: { authorization: `Bearer ${openrouterKey}` } };
  }
  if (source === 'vercel') {
    return { url: VERCEL_JEV_API_URL, model: VERCEL_JEV_MODEL, headers: { authorization: `Bearer ${vercelKey}` } };
  }
  // Every Zen call names OpenChamber, so zen can see or throttle it.
  if (source === 'zen-key') {
    return { url: ZEN_JEV_API_URL, model: ZEN_JEV_PAID_MODEL, headers: { authorization: `Bearer ${zenKey}`, 'x-opencode-client': ZEN_CLIENT_ID } };
  }
  return { url: ZEN_JEV_API_URL, model: ZEN_JEV_MODEL, headers: { 'x-opencode-client': ZEN_CLIENT_ID } };
};
