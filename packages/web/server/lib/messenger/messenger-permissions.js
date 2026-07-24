/**
 * Shared permission-mode model for the Discord ↔ OpenCode bridge.
 *
 * OpenCode asks for approval before it runs certain tools (shell commands,
 * file edits/writes, web fetches, …). By default the bridge forwards every
 * request to Discord as an Approve / Always / Deny button set. The
 * permission mode lets a user pre-decide how those requests are handled for
 * a conversation, project, or the whole bot:
 *
 *   - `ask`   — ask for every tool OpenCode surfaces (Ask all).
 *   - `yolo`  — allow every tool without prompting (Allow all); stop a run
 *               with `/abort`.
 *   - `agent` — follow the active agent's permission settings (allow / ask /
 *               deny per tool). This is the default.
 *
 * Legacy stored value `auto-edit` normalizes to `agent`.
 *
 * Both `/yolo` and its synonym `/permissions` (dropdown wizard + text form)
 * and the bridge's `permission.asked` handler read the SAME resolved value,
 * so the policy is enforced in core logic and never only in the UI.
 */

export const PERMISSION_MODES = ['ask', 'yolo', 'agent'];

export const DEFAULT_PERMISSION_MODE = 'agent';

export const PERMISSION_MODE_DESCRIPTIONS = {
  ask: 'Ask all — Approve / Deny buttons for every tool',
  yolo: 'Allow all commands — no prompts (stop a run with /abort)',
  agent: 'Follow the active agent permission settings for each tool',
};

/** Short labels for confirmations / status lines. */
export const PERMISSION_MODE_LABELS = {
  ask: 'Ask all',
  yolo: 'Allow all',
  agent: 'Follow agent settings',
};

const PERMISSION_ALIASES = new Map([
  ['ask', 'ask'],
  ['ask-all', 'ask'],
  ['askall', 'ask'],
  ['always-ask', 'ask'],
  ['alwaysask', 'ask'],
  ['default', 'ask'],
  ['manual', 'ask'],
  ['prompt', 'ask'],
  ['confirm', 'ask'],
  ['off', 'ask'],
  ['yolo', 'yolo'],
  ['allow-all', 'yolo'],
  ['allowall', 'yolo'],
  ['allow', 'yolo'],
  ['auto-all', 'yolo'],
  ['autoall', 'yolo'],
  ['all', 'yolo'],
  ['full', 'yolo'],
  ['on', 'yolo'],
  ['agent', 'agent'],
  ['follow', 'agent'],
  ['follow-agent', 'agent'],
  ['followagent', 'agent'],
  ['follow-agent-settings', 'agent'],
  ['agent-settings', 'agent'],
  // Legacy auto-edit → follow agent settings
  ['auto-edit', 'agent'],
  ['autoedit', 'agent'],
  ['auto', 'agent'],
  ['edits', 'agent'],
  ['edit', 'agent'],
  ['safe', 'agent'],
]);

const ACTIONS = new Set(['allow', 'ask', 'deny']);

/**
 * Map free-text input (from `/yolo|/permissions <mode>` or a wizard value) to
 * a canonical mode. Returns `null` for unrecognised input so callers can show
 * an error.
 */
export function parsePermissionMode(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return PERMISSION_ALIASES.get(normalized) ?? null;
}

/** Coerce any value to a valid mode, falling back to `agent`. */
export function normalizePermissionMode(value) {
  if (PERMISSION_MODES.includes(value)) return value;
  // Persisted legacy value from before ask/yolo/agent.
  if (value === 'auto-edit') return 'agent';
  return DEFAULT_PERMISSION_MODE;
}

/**
 * Resolve the agent's configured action for a tool.
 *
 * Accepts either:
 *   - OpenCode `/agent` effective rules: `[{ permission, pattern, action }]`
 *   - Source permission config map: `{ bash: 'ask', edit: { '*': 'allow' }, '*': 'ask' }`
 *
 * Missing / unrecognised config falls back to `ask` (safe).
 */
export function resolveAgentToolAction(permission, toolName) {
  const tool = String(toolName ?? '')
    .trim()
    .toLowerCase();
  if (!tool) return 'ask';

  if (Array.isArray(permission)) {
    let toolWildcard = null;
    let globalWildcard = null;
    for (let index = permission.length - 1; index >= 0; index -= 1) {
      const rule = permission[index];
      if (!rule || typeof rule !== 'object') continue;
      const action = rule.action;
      if (!ACTIONS.has(action)) continue;
      const rulePermission = String(rule.permission ?? '')
        .trim()
        .toLowerCase();
      const pattern = String(rule.pattern ?? '*');
      if (rulePermission === tool && pattern === '*') return action;
      if (rulePermission === tool && toolWildcard == null) toolWildcard = action;
      if (rulePermission === '*' && pattern === '*' && globalWildcard == null) {
        globalWildcard = action;
      }
    }
    return toolWildcard ?? globalWildcard ?? 'ask';
  }

  if (permission && typeof permission === 'object') {
    const readEntry = (entry) => {
      if (ACTIONS.has(entry)) return entry;
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && ACTIONS.has(entry['*'])) {
        return entry['*'];
      }
      return null;
    };
    const specific = readEntry(permission[tool] ?? permission[toolName]);
    if (specific) return specific;
    const global = readEntry(permission['*']);
    if (global) return global;
  }

  return 'ask';
}

/**
 * Whether a permission request for `toolName` should be auto-approved under
 * `mode`. `ask` never auto-approves; `yolo` always does; `agent` follows
 * `agentAction` from {@link resolveAgentToolAction}.
 */
export function shouldAutoApprove(mode, toolName, agentAction = null) {
  const m = normalizePermissionMode(mode);
  if (m === 'yolo') return true;
  if (m === 'agent') return agentAction === 'allow';
  return false;
}

/** Whether agent mode should auto-reject based on the agent's deny action. */
export function shouldAutoDeny(mode, agentAction = null) {
  return normalizePermissionMode(mode) === 'agent' && agentAction === 'deny';
}
