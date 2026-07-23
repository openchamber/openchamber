import crypto from 'node:crypto';

/**
 * Shared primitives for Discord interactive select-menu wizards
 * (`/model`, `/agent`, `/verbosity`, `/skill`).
 *
 * Discord string-select menus are capped at 25 options, so any list longer than
 * that has to be paged. These helpers render paged select rows and keep a small
 * TTL-bounded state map keyed by a short random hash embedded in each select's
 * `custom_id`. Keeping them in one place means every wizard paginates, expires
 * and renders identically — and the model wizard's behaviour (and its tests)
 * stay unchanged.
 */

export const WIZARD_TTL_MS = 10 * 60 * 1000;
// Discord string-select menus hard-cap at 25 options.
export const DISCORD_SELECT_MAX = 25;
// Default real choices per page when prev/next live inside the select
// (up to two slots reserved for in-menu navigation).
export const PAGE_SIZE = 23;
// When page nav is moved to buttons, the select can use the full 25 slots.
export const PAGE_SIZE_WITH_BUTTON_NAV = DISCORD_SELECT_MAX;

export const PREV_VALUE = '__openchamber_agent_prev';
export const NEXT_VALUE = '__openchamber_agent_next';
export const BACK_VALUE = '__openchamber_agent_back';

/**
 * Rewrite deprecated Otto Discord component ids / select values to the
 * OpenChamber agent namespace so in-flight messages keep working after rename.
 */
export function normalizeLegacyDiscordCustomId(customId) {
  if (typeof customId !== 'string') return customId;
  const pairs = [
    ['otto-agent-pick:', 'openchamber-agent-pick:'],
    ['otto-agent-scope:', 'openchamber-agent-scope:'],
    ['otto-', 'openchamber-agent-'],
  ];
  for (const [from, to] of pairs) {
    if (customId.startsWith(from)) {
      return `${to}${customId.slice(from.length)}`;
    }
  }
  return customId;
}

export function normalizeLegacyDiscordSelectValue(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('__otto_')) {
    return `__openchamber_agent_${value.slice('__otto_'.length)}`;
  }
  return value;
}

/**
 * Build a paged set of Discord select options from `items`.
 *
 * @param {Array<{label:string,value:string,description?:string}>} items
 * @param {number} page zero-based page index (clamped into range)
 * @param {{ pageSize?: number, includeNav?: boolean }} [opts]
 *   - `pageSize` defaults to {@link PAGE_SIZE} (23) when in-select nav is on,
 *     or {@link PAGE_SIZE_WITH_BUTTON_NAV} (25) when `includeNav` is false.
 *   - `includeNav` (default true) embeds ◀ Previous / More ▶ inside the select.
 * @returns {{ options: Array, page: number, totalPages: number }}
 */
export function buildPagedOptions(items, page, opts = {}) {
  const includeNav = opts.includeNav !== false;
  const pageSize = Math.max(
    1,
    Math.min(
      DISCORD_SELECT_MAX,
      opts.pageSize ?? (includeNav ? PAGE_SIZE : PAGE_SIZE_WITH_BUTTON_NAV),
    ),
  );
  const total = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page | 0), totalPages - 1);
  const start = safePage * pageSize;
  const options = items.slice(start, start + pageSize).map((o) => ({ ...o }));
  if (includeNav && safePage > 0) {
    options.unshift({
      label: '◀ Previous',
      value: PREV_VALUE,
      description: `Page ${safePage} of ${totalPages}`,
    });
  }
  if (includeNav && safePage < totalPages - 1) {
    options.push({
      label: 'More ▶',
      value: NEXT_VALUE,
      description: `Page ${safePage + 2} of ${totalPages}`,
    });
  }
  return { options, page: safePage, totalPages, pageSize };
}

/** A single-row string-select component. Options are clamped to Discord's 25 max. */
export function stringSelect(customId, options, placeholder) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customId,
        options: options.slice(0, 25),
        placeholder: placeholder ?? 'Select…',
      },
    ],
  };
}

/**
 * A single-row action bar of buttons. Styles: 1=primary, 2=secondary,
 * 3=success, 4=danger. Discord caps an action row at 5 buttons.
 */
export function buttonRow(buttons) {
  return {
    type: 1,
    components: buttons.slice(0, 5).map((b) => ({
      type: 2,
      style: b.style ?? 1,
      label: String(b.label ?? '').slice(0, 80),
      custom_id: b.customId,
      ...(b.emoji ? { emoji: b.emoji } : {}),
    })),
  };
}

/** Stable short hash of a bot token — used to scope per-surface store writes. */
export function botHashFor(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

/** A short random id embedded in each wizard's select `custom_id`. */
export function randomWizardHash() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * A TTL-bounded map of in-flight wizard state, keyed by hash. Entries expire
 * after {@link WIZARD_TTL_MS} so abandoned wizards don't leak memory.
 */
export function createWizardStore() {
  const state = new Map();
  const timers = new Map();

  function set(hash, data) {
    const existing = timers.get(hash);
    if (existing) clearTimeout(existing);
    state.set(hash, data);
    const timer = setTimeout(() => {
      state.delete(hash);
      timers.delete(hash);
    }, WIZARD_TTL_MS);
    timer.unref?.();
    timers.set(hash, timer);
  }

  function get(hash) {
    return state.get(hash) ?? null;
  }

  function del(hash) {
    const timer = timers.get(hash);
    if (timer) {
      clearTimeout(timer);
      timers.delete(hash);
    }
    state.delete(hash);
  }

  return { set, get, del };
}
