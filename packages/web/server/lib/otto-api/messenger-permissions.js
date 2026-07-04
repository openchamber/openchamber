/**
 * Shared permission-mode model for the Discord ↔ OpenCode bridge.
 *
 * OpenCode asks for approval before it runs certain tools (shell commands,
 * file edits/writes, web fetches, …). By default the bridge forwards every
 * request to Discord as an Approve / Always / Deny button set. The
 * permission mode lets a user pre-decide how those requests are handled for
 * a conversation, project, or the whole bot — the "yolo" affordance:
 *
 *   - `ask`       — always prompt with buttons (the default, safest).
 *   - `auto-edit` — auto-approve low-risk edit/read tools (edit, write, patch,
 *                   read, list, grep, glob, webfetch); still prompt for shell
 *                   commands and anything unrecognised.
 *   - `yolo`      — auto-approve everything. Nothing is prompted; the user can
 *                   still stop the run with `/abort`.
 *
 * Both the `/yolo` Discord command (dropdown wizard + text form) and the
 * bridge's `permission.asked` handler read the SAME resolved value, so the
 * policy is enforced in core logic and never only in the UI.
 */

export const PERMISSION_MODES = ['ask', 'auto-edit', 'yolo'];

export const DEFAULT_PERMISSION_MODE = 'ask';

export const PERMISSION_MODE_DESCRIPTIONS = {
  ask: 'Ask every time — Approve / Deny buttons for each tool (default)',
  'auto-edit': 'Auto-approve file edits + reads; still ask before running shell commands',
  yolo: 'Auto-approve everything — no prompts (stop a run with /abort)',
};

/** Short labels for confirmations / status lines. */
export const PERMISSION_MODE_LABELS = {
  ask: 'Ask every time',
  'auto-edit': 'Auto-approve edits',
  yolo: 'YOLO — auto-approve all',
};

const PERMISSION_ALIASES = new Map([
  ['ask', 'ask'],
  ['default', 'ask'],
  ['manual', 'ask'],
  ['prompt', 'ask'],
  ['confirm', 'ask'],
  ['off', 'ask'],
  ['auto-edit', 'auto-edit'],
  ['autoedit', 'auto-edit'],
  ['auto', 'auto-edit'],
  ['edits', 'auto-edit'],
  ['edit', 'auto-edit'],
  ['safe', 'auto-edit'],
  ['yolo', 'yolo'],
  ['auto-all', 'yolo'],
  ['autoall', 'yolo'],
  ['all', 'yolo'],
  ['full', 'yolo'],
  ['on', 'yolo'],
]);

/**
 * Tools auto-approved under `auto-edit`. Kept conservative: read/edit style
 * tools that mutate or read files inside the workspace, plus web fetches.
 * Shell commands (`bash`) and anything not listed here still prompt.
 */
const AUTO_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'patch',
  'read',
  'list',
  'ls',
  'glob',
  'grep',
  'search',
  'webfetch',
  'fetch',
]);

/**
 * Map free-text input (from `/yolo <mode>` or a wizard value) to a canonical
 * mode. Returns `null` for unrecognised input so callers can show an error.
 */
export function parsePermissionMode(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return PERMISSION_ALIASES.get(normalized) ?? null;
}

/** Coerce any value to a valid mode, falling back to `ask`. */
export function normalizePermissionMode(value) {
  return PERMISSION_MODES.includes(value) ? value : DEFAULT_PERMISSION_MODE;
}

/**
 * Whether a permission request for `toolName` should be auto-approved under
 * `mode`. `ask` never auto-approves; `yolo` always does; `auto-edit` only
 * auto-approves the low-risk edit/read tool set above.
 */
export function shouldAutoApprove(mode, toolName) {
  const m = normalizePermissionMode(mode);
  if (m === 'yolo') return true;
  if (m === 'auto-edit') return AUTO_EDIT_TOOLS.has(String(toolName ?? '').trim().toLowerCase());
  return false;
}
