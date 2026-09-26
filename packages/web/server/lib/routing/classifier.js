/**
 * Which service answers Jev requests: the classification provider.
 *
 * - `zen-promo`: OpenCode Zen's free promotional model, no credential.
 * - `zen-key`: the paid model on the same endpoint, with a Zen API key the user
 *   saved in OpenCode.
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
  ZEN_CLIENT_ID,
  ZEN_JEV_API_URL,
  ZEN_JEV_MODEL,
  ZEN_JEV_PAID_MODEL,
} from './defaults.js';

export const CLASSIFIER_SOURCES = ['zen-promo', 'zen-key', 'typesafe'];
const FALLBACK_ORDER = ['typesafe', 'zen-key', 'zen-promo'];

/**
 * `selected` is the stored pick or null. Before the pick existed a saved
 * TypeSafe key always won, so that stays the default when one is present.
 */
export const resolveClassifier = ({ selected, typesafeKey, zenKey, zenPromotionActive }) => {
  const usable = {
    'zen-promo': Boolean(zenPromotionActive),
    'zen-key': Boolean(zenKey),
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

/** The request target for a usable source. */
export const classifierEndpoint = (source, { typesafeKey, zenKey }) => {
  if (source === 'typesafe') {
    return { url: JEV_API_URL, model: JEV_MODEL, headers: { authorization: `Bearer ${typesafeKey}` } };
  }
  // Every Zen call names OpenChamber, so zen can see or throttle it.
  if (source === 'zen-key') {
    return { url: ZEN_JEV_API_URL, model: ZEN_JEV_PAID_MODEL, headers: { authorization: `Bearer ${zenKey}`, 'x-opencode-client': ZEN_CLIENT_ID } };
  }
  return { url: ZEN_JEV_API_URL, model: ZEN_JEV_MODEL, headers: { 'x-opencode-client': ZEN_CLIENT_ID } };
};
