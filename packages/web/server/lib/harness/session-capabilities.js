/**
 * Per-session Claude capability snapshot from system/init (slash commands,
 * MCP status, agents, skills, tools). In-memory only — not durable secrets.
 */

/** @typedef {{
 *   sessionId: string,
 *   foreignSessionId?: string,
 *   slashCommands: string[],
 *   skills: string[],
 *   agents: string[],
 *   tools: string[],
 *   mcpServers: Array<{ name: string, status: string }>,
 *   updatedAt: number,
 * }} SessionCapabilities */

/** @type {Map<string, SessionCapabilities>} */
const bySessionId = new Map();

/**
 * Built-in Claude Code slash commands that work without a TTY and are safe to
 * offer before the first system/init arrives.
 * @type {readonly string[]}
 */
export const CLAUDE_BUILTIN_SLASH_COMMANDS = Object.freeze([
  'clear',
  'compact',
  'context',
  'cost',
  'init',
  'pr-comments',
  'release-notes',
  'review',
  'security-review',
  'usage',
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Array<{ name: string, status: string }>}
 */
function sanitizeMcpServers(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Array<{ name: string, status: string }>} */
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const status = typeof entry.status === 'string' && entry.status.trim()
      ? entry.status.trim()
      : 'unknown';
    out.push({ name, status });
  }
  return out;
}

/**
 * @param {string} sessionId
 * @returns {SessionCapabilities | null}
 */
export function getSessionCapabilities(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return bySessionId.get(sessionId.trim()) || null;
}

/**
 * Public JSON shape for GET /api/harness/sessions/:id/capabilities.
 * Always returns a payload (with built-in slash defaults) even before init.
 *
 * @param {string} sessionId
 * @returns {SessionCapabilities}
 */
export function getOrCreateSessionCapabilities(sessionId) {
  const existing = getSessionCapabilities(sessionId);
  if (existing) return existing;
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    sessionId: id,
    slashCommands: [...CLAUDE_BUILTIN_SLASH_COMMANDS],
    skills: [],
    agents: [],
    tools: [],
    mcpServers: [],
    updatedAt: 0,
  };
}

/**
 * Merge a system/init (or partial) capability update for a Claude session.
 *
 * @param {string} sessionId
 * @param {object} [input]
 * @returns {SessionCapabilities | null}
 */
export function updateSessionCapabilities(sessionId, input = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;

  const prev = bySessionId.get(id);
  const hasSlash = Array.isArray(input.slashCommands) || Array.isArray(input.slash_commands);
  const hasSkills = Array.isArray(input.skills);
  const hasAgents = Array.isArray(input.agents);
  const hasTools = Array.isArray(input.tools);
  const hasMcp = Array.isArray(input.mcpServers) || Array.isArray(input.mcp_servers);

  const slashCommands = hasSlash
    ? sanitizeStringList(input.slashCommands ?? input.slash_commands)
    : null;
  const skills = hasSkills ? sanitizeStringList(input.skills) : null;
  const agents = hasAgents ? sanitizeStringList(input.agents) : null;
  const tools = hasTools ? sanitizeStringList(input.tools) : null;
  const mcpServers = hasMcp
    ? sanitizeMcpServers(input.mcpServers ?? input.mcp_servers)
    : null;

  const foreignSessionId = typeof input.foreignSessionId === 'string' && input.foreignSessionId.trim()
    ? input.foreignSessionId.trim()
    : typeof input.session_id === 'string' && input.session_id.trim()
      ? input.session_id.trim()
      : prev?.foreignSessionId;

  /** @type {SessionCapabilities} */
  const next = {
    sessionId: id,
    slashCommands: slashCommands && slashCommands.length > 0
      ? slashCommands
      : (prev?.slashCommands?.length ? prev.slashCommands : [...CLAUDE_BUILTIN_SLASH_COMMANDS]),
    skills: skills ?? prev?.skills ?? [],
    agents: agents ?? prev?.agents ?? [],
    tools: tools ?? prev?.tools ?? [],
    mcpServers: mcpServers ?? prev?.mcpServers ?? [],
    updatedAt: Date.now(),
  };
  if (foreignSessionId) next.foreignSessionId = foreignSessionId;

  bySessionId.set(id, next);
  return next;
}

/**
 * @param {string} sessionId
 */
export function clearSessionCapabilities(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  bySessionId.delete(sessionId.trim());
}

/** Test helper. */
export function resetSessionCapabilities() {
  bySessionId.clear();
}

/**
 * Whether a slash command name is known for this Claude session (discovered or built-in).
 *
 * @param {string} sessionId
 * @param {string} commandName
 * @returns {boolean}
 */
export function isClaudeSlashCommand(sessionId, commandName) {
  const name = typeof commandName === 'string' ? commandName.trim().replace(/^\//, '') : '';
  if (!name) return false;
  const caps = getOrCreateSessionCapabilities(sessionId);
  const lower = name.toLowerCase();
  return caps.slashCommands.some((cmd) => cmd.toLowerCase() === lower)
    || caps.skills.some((skill) => skill.toLowerCase() === lower);
}
