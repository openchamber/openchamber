// Standardized card templates for the model tier chooser and the quota
// fallback, drawn through `render.page` with `awaitAnswer`.
//
// Both builders are pure: they take plain data (tiers, models, pricing,
// quota context) from the caller and return one self-contained HTML document
// string. Pricing lookup lives with the caller, never here. Every
// interpolated value is HTML-escaped, and each tile submits its answer with
// `openchamber.submit(data, summary)` from a click handler.
//
// Styling uses the app variables named in issue #14 (`--bg-base`,
// `--text-primary`, `--border-base`, `--accent-primary`) and the `font-sans`
// class, so the card follows the chat theme.

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escape anything interpolated into the card markup. */
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);

const TIER_CHOOSER_TITLE = 'Select Execution Tier';
const QUOTA_FALLBACK_TITLE = 'Quota Limit Reached';

const FALLBACK_KINDS = ['switch-provider', 'downgrade-tier', 'wait-for-reset'];

const capitalizeTier = (tier) => {
  const text = String(tier ?? '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
};

/** `Selected Cheap Tier (<model>)`, the summary shape from issue #14. */
const tierChoiceSummary = (tier, model) => `Selected ${capitalizeTier(tier)} Tier (${String(model ?? '')})`;

const cardStyle = () => [
  '<style>',
  '.tier-card{background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-base);border-radius:12px;padding:16px;max-width:640px}',
  '.tier-card h1{font-size:1.1rem;margin:0 0 4px}',
  '.tier-card p{margin:0 0 12px}',
  '.tier-card .oc-options{display:grid;gap:8px}',
  '.tier-card .oc-option{display:block;width:100%;text-align:left;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-base);border-radius:8px;padding:12px;cursor:pointer}',
  '.tier-card .oc-option:hover{border-color:var(--accent-primary)}',
  '.tier-card .oc-option[aria-pressed="true"]{border-color:var(--accent-primary)}',
  '.tier-card .tier-choose{display:inline-block;margin-top:8px;background:var(--accent-primary);border-radius:6px;padding:4px 10px}',
  '</style>',
].join('');

const answerScript = () => [
  '<script>(function(){',
  'var buttons=document.querySelectorAll("[data-payload]");',
  'buttons.forEach(function(btn){',
  'btn.addEventListener("click",function(){',
  'if(btn.disabled)return;',
  'var payload;try{payload=JSON.parse(btn.getAttribute("data-payload"));}catch(e){return;}',
  'var summary=btn.getAttribute("data-summary")||(btn.textContent||"").trim();',
  'btn.disabled=true;',
  'window.openchamber.submit(payload,summary).then(function(){btn.setAttribute("aria-pressed","true");})',
  '.catch(function(){btn.disabled=false;});',
  '});});})();</script>',
].join('');

const buildDocument = ({ title, bodyHtml }) => [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${escapeHtml(title)}</title>`,
  cardStyle(),
  `</head><body class="font-sans"><div class="tier-card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div>`,
  answerScript(),
  '</body></html>',
].join('');

const pricingLine = ({ inputPerM, outputPerM }) => {
  if (inputPerM === undefined && outputPerM === undefined) return '';
  const parts = [];
  if (inputPerM !== undefined) parts.push(`$${escapeHtml(inputPerM)} in`);
  if (outputPerM !== undefined) parts.push(`$${escapeHtml(outputPerM)} out`);
  return `<div class="tier-pricing">${parts.join(' / ')} per 1M</div>`;
};

/**
 * Tier chooser card: one tile per tier, each submitting `{ tier, model }`.
 *
 * `tiers` entries: `{ tier, model, label?, inputPerM?, outputPerM?,
 * latency?, description? }`. Pricing fields are caller-supplied
 * models.dev values, rendered as given.
 */
export const buildTierChooserCard = ({ title = TIER_CHOOSER_TITLE, tiers = [] } = {}) => {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('buildTierChooserCard needs a non-empty tiers array');
  }
  for (const entry of tiers) {
    if (!entry || !entry.tier || !entry.model) {
      throw new Error('buildTierChooserCard needs { tier, model } for every tier');
    }
  }
  const tiles = tiers.map((entry) => {
    const payload = JSON.stringify({ tier: entry.tier, model: entry.model });
    const summary = tierChoiceSummary(entry.tier, entry.model);
    const heading = entry.label ? entry.label : `${capitalizeTier(entry.tier)} · ${entry.model}`;
    const details = [
      entry.description ? `<div class="tier-desc">${escapeHtml(entry.description)}</div>` : '',
      pricingLine(entry),
      entry.latency ? `<div class="tier-latency">${escapeHtml(entry.latency)}</div>` : '',
    ].join('');
    return [
      `<button type="button" class="oc-option" data-tier="${escapeHtml(entry.tier)}"`,
      ` data-model="${escapeHtml(entry.model)}"`,
      ` data-payload="${escapeHtml(payload)}" data-summary="${escapeHtml(summary)}">`,
      `<div class="tier-name">${escapeHtml(heading)}</div>`,
      `<div class="tier-model">${escapeHtml(entry.model)}</div>`,
      details,
      `<span class="tier-choose">Choose ${escapeHtml(capitalizeTier(entry.tier))}</span>`,
      '</button>',
    ].join('');
  }).join('');
  return buildDocument({ title, bodyHtml: `<div class="oc-options">${tiles}</div>` });
};

const FALLBACK_LABELS = {
  'switch-provider': 'Switch provider',
  'downgrade-tier': 'Downgrade tier',
  'wait-for-reset': 'Wait for reset',
};

/**
 * Quota fallback card: tiles for switch-provider, downgrade-tier and
 * wait-for-reset, each submitting `{ action: 'fallback', provider, tier }`.
 *
 * `actions` entries: `{ kind, label?, detail?, provider, tier, summary? }`.
 * `message` carries the quota context (which provider/quota hit, reset hint).
 */
export const buildQuotaFallbackCard = ({
  title = QUOTA_FALLBACK_TITLE,
  message = '',
  currentProvider = '',
  currentTier = '',
  actions = [],
} = {}) => {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('buildQuotaFallbackCard needs a non-empty actions array');
  }
  const kinds = actions.map((action) => action && action.kind);
  for (const kind of FALLBACK_KINDS) {
    if (!kinds.includes(kind)) {
      throw new Error(`buildQuotaFallbackCard needs a ${kind} action`);
    }
  }
  for (const action of actions) {
    if (!action || !action.provider || !action.tier) {
      throw new Error('buildQuotaFallbackCard needs { provider, tier } for every action');
    }
  }
  const context = [
    message ? `<p>${escapeHtml(message)}</p>` : '',
    currentProvider || currentTier
      ? `<p>Current: ${escapeHtml(currentProvider)} / ${escapeHtml(currentTier)}</p>`
      : '',
  ].join('');
  const tiles = actions.map((action) => {
    const payload = JSON.stringify({ action: 'fallback', provider: action.provider, tier: action.tier });
    const summary = action.summary || action.label || `${FALLBACK_LABELS[action.kind] || action.kind}: ${action.provider}/${action.tier}`;
    const heading = action.label || FALLBACK_LABELS[action.kind] || action.kind;
    return [
      `<button type="button" class="oc-option" data-kind="${escapeHtml(action.kind)}"`,
      ` data-provider="${escapeHtml(action.provider)}" data-tier="${escapeHtml(action.tier)}"`,
      ` data-payload="${escapeHtml(payload)}" data-summary="${escapeHtml(summary)}">`,
      `<div class="tier-name">${escapeHtml(heading)}</div>`,
      `<div class="tier-model">${escapeHtml(action.provider)} / ${escapeHtml(action.tier)}</div>`,
      action.detail ? `<div class="tier-desc">${escapeHtml(action.detail)}</div>` : '',
      `<span class="tier-choose">${escapeHtml(heading)}</span>`,
      '</button>',
    ].join('');
  }).join('');
  return buildDocument({ title, bodyHtml: `${context}<div class="oc-options">${tiles}</div>` });
};
