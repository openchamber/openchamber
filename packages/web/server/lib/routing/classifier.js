/**
 * Which service answers Jev requests: the classification provider.
 *
 * - `zen-promo`: OpenCode Zen's free promotional model, no credential.
 * - `zen-key`: the paid model on the same endpoint, with a Zen API key the user
 *   saved in OpenCode.
 * - `openrouter`, `vercel`: the same System One API through OpenRouter or
 *   Vercel AI Gateway, with the key the user saved for that provider in
 *   OpenCode.
 * - `typesafe`: TypeSafe's own API with a key saved in OpenChamber.
 *
 * The user picks one. A pick that cannot be used right now (the promotion
 * ended, the key was removed) falls back to the first usable source, own keys
 * first, so Jev stays available whenever any source is. No usable source at
 * all means no Jev: the safety net and Auto are not offered.
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

export const CLASSIFIER_SOURCES = ['zen-promo', 'zen-key', 'openrouter', 'vercel', 'typesafe'];
const FALLBACK_ORDER = ['typesafe', 'openrouter', 'vercel', 'zen-key', 'zen-promo'];

/** The sources clients from v2.0.2 parse; any other id fails their whole routing state. */
const LEGACY_SOURCES = ['zen-promo', 'zen-key', 'typesafe'];

/**
 * `selected` is the stored pick or null. Before the pick existed a saved
 * TypeSafe key always won, so that stays the default when one is present.
 */
export const resolveClassifier = ({ selected, typesafeKey, zenKey, openrouterKey, vercelKey, zenPromotionActive }) => {
  const usable = {
    'zen-promo': Boolean(zenPromotionActive),
    'zen-key': Boolean(zenKey),
    openrouter: Boolean(openrouterKey),
    vercel: Boolean(vercelKey),
    typesafe: Boolean(typesafeKey),
  };
  const chosen = selected ?? (typesafeKey ? 'typesafe' : 'zen-promo');
  const effective = usable[chosen] ? chosen : FALLBACK_ORDER.find((source) => usable[source]) ?? null;
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
 * a newer server. With OpenRouter or Vercel in play they get null and show
 * the provider page as unavailable; the features keep working.
 */
export const legacyClassifier = (classifier) => {
  const legacy = (source) => source === null || LEGACY_SOURCES.includes(source);
  if (!legacy(classifier.selected) || !legacy(classifier.effective)) return null;
  return { ...classifier, sources: classifier.sources.filter((source) => LEGACY_SOURCES.includes(source.id)) };
};

/** The request target for a usable source. */
export const classifierEndpoint = (source, { typesafeKey, zenKey, openrouterKey, vercelKey }) => {
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
