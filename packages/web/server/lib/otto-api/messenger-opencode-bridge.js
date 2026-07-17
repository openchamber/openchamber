import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MessengerBridgeStore } from './messenger-bridge-store.js';
import { executeMessengerCommand, parseLeadingCommand, isKnownMessengerCommand } from './messenger-commands.js';
import { DEFAULT_VERBOSITY, normalizeVerbosity } from './messenger-verbosity.js';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_LABELS,
  normalizePermissionMode,
  shouldAutoApprove,
} from './messenger-permissions.js';
import {
  renderPartForMessenger,
  renderPermissionContext,
  renderQuestionForMessenger,
  renderTodoListForMessenger,
  renderUserShellResult,
  isUserShellMarkerText,
  escapeMd,
  clipBlock,
  deriveThreadNameFromSessionTitle,
  THINKING_MARKER,
  extractLastAssistantTokens,
  computeTurnTokens,
} from './messenger-render.js';
import { processDiscordAttachments, composePromptText } from './messenger-attachments.js';
import {
  createBridgeWorktree,
  mergeBridgeWorktree,
  sanitizeWorktreeName,
  MERGE_CONFLICT_PROMPT,
} from './messenger-worktrees.js';
import parser from 'cron-parser';

/**
 * Bidirectional bridge between Discord and OpenCode chat sessions.
 *
 * Threading model:
 *   - Each new conversation starter in a Discord text channel spawns a public
 *     Thread on that message via POST /channels/:id/messages/:id/threads. The
 *     OpenCode session is bound to the THREAD, not the channel. Follow-up
 *     messages posted inside the thread reuse the same session.
 *
 * Outbound model:
 *   - One new Discord message per renderable OpenCode part.
 *     No edit-in-place — text streams complete (part.time.end set) before
 *     they're posted, tool runs post a single one-liner per state change,
 *     reasoning posts a `┣ thinking` marker.
 *   - Tool summaries use a compact format: file name and ±line
 *     count for edits, file name for reads, escaped command for bash,
 *     match count for glob/grep, etc. Not `[⋯ tool-name]`.
 *   - Typing indicator pulses every 7s while a session has unfinished
 *     assistant work — to give the user a visible "thinking…" affordance
 *     without spamming the chat.
 */

const DISCORD_LIMIT = 2000;
const NAME_TTL_MS = 5 * 60_000;
const TYPING_PULSE_DISCORD_MS = 7_000;

function tokenHash(token) {
  if (!token) return '';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

/** Slug a project label into a Discord channel name (matches messenger-sync.js). */
function slugifyProjectLabel(label) {
  return (
    String(label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'project'
  );
}

/** Best-effort human label from a Discord channel name (inverse of slug). */
function labelFromChannelName(name) {
  return (
    String(name ?? '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Project'
  );
}

/**
 * Stable key identifying a conversation surface. We want the SAME key
 * whether the gateway delivers a brand-new message in a parent channel
 * (we're about to spawn a thread) or a follow-up inside an existing
 * thread.
 *
 * Discord: thread channels carry their own unique IDs, so once a thread
 *   exists we key purely by the thread id. The parent-channel id is
 *   irrelevant from then on (and Discord MESSAGE_CREATE on a follow-up
 *   gives us `channel_id = thread_id` with no `parent_id` in the payload).
 */
function targetKey({ type, channelId, threadId }) {
  if (type === 'discord') {
    return threadId ? `${threadId}` : `${channelId}`;
  }
  return threadId ? `${channelId}:${threadId}` : `${channelId}`;
}

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Turn an OpenCode `session.error` payload into a short, human-readable line.
 *
 * OpenCode errors arrive in several shapes (`{ message }`, `{ data: { message } }`,
 * `{ cause: { failures: [...] } }`, or a bare object). Dumping the raw JSON to a
 * chat surface is hostile — it gets truncated mid-string and exposes internals.
 * In particular, Drizzle/SQLite write failures carry a giant SQL query with bind
 * placeholders that is meaningless to a chat user, so we collapse those to a
 * single friendly sentence.
 */
function formatSessionError(raw) {
  if (!raw) return 'OpenCode session error';
  if (typeof raw === 'string') return raw.trim() || 'OpenCode session error';

  let msg =
    (typeof raw.message === 'string' && raw.message) ||
    (typeof raw.data?.message === 'string' && raw.data.message) ||
    (typeof raw.error?.message === 'string' && raw.error.message) ||
    '';
  if (!msg && raw.cause && typeof raw.cause === 'object') {
    const c = raw.cause;
    const failures = Array.isArray(c.failures) ? c.failures : Array.isArray(c) ? c : null;
    if (failures && failures.length > 0) {
      const first = failures[0];
      msg = first?.error?.message ?? first?.message ?? first?.error ?? '';
    }
  }
  if (!msg) {
    try {
      msg = JSON.stringify(raw);
    } catch {
      msg = String(raw);
    }
  }
  msg = String(msg).trim();

  // Collapse noisy DB write failures (huge SQL + bind placeholders) into one
  // clear sentence instead of a truncated query dump.
  if (/DrizzleQueryError|Failed query:|\binsert into\b|\bon conflict\b/i.test(msg)) {
    return 'OpenCode could not save the message (database write error). The turn was not recorded — please try again.';
  }

  // Otherwise keep the first line and drop any stack-trace tail.
  const firstLine = msg.split('\n')[0].trim();
  return firstLine || 'OpenCode session error';
}

/**
 * Heuristic: does an error text look like the transient teardown of a turn that
 * was just aborted/superseded (rather than a genuine, actionable failure)?
 * These are the exact symptoms users hit when they interrupt a turn or switch
 * model mid-stream — the aborted turn's connection collapses and OpenCode
 * reports a stream/provider error for work that was intentionally cancelled.
 */
function isTransientTurnError(text) {
  if (typeof text !== 'string' || !text) return false;
  return /aborted|abort|cancel|stream(ing)?\s+response\s+failed|provider\s+not\s+available|connection\s+(closed|reset|refused)|fetch failed|network|ECONNRESET|socket hang up|terminated/i.test(
    text,
  );
}

function pickProjectForName(projects, name) {
  if (!name) return null;
  const wanted = slugify(name);
  if (!wanted) return null;
  for (const p of projects) {
    const candidates = [
      slugify(p.label ?? ''),
      slugify((p.path ?? '').split('/').pop() ?? ''),
      slugify(p.id ?? ''),
    ];
    if (candidates.includes(wanted)) return p;
  }
  for (const p of projects) {
    const candidates = [
      slugify(p.label ?? ''),
      slugify((p.path ?? '').split('/').pop() ?? ''),
    ].filter(Boolean);
    if (candidates.some((c) => wanted.includes(c) || c.includes(wanted))) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discord REST adapters
// ---------------------------------------------------------------------------

async function sendDiscord({ token, channelId, content }) {
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, DISCORD_LIMIT) }),
    },
  );
  if (!r.ok) return { ok: false, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data = await r.json();
  return { ok: true, id: data.id };
}

// ── Approval flow helpers ─────────────────────────────────────────────
// Maps approvalId → { sessionID, requestID, directory, sdkDirectory }
// so button clicks can be routed back to OpenCode's permission.reply API.
export const approvalContexts = new Map();

/** Generate a unique approval ID. */
function generateApprovalId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * True when an Approve/Deny message for this OpenCode permission/request id is
 * still live (posted, not yet decided or expired). This is the strongest
 * dedupe signal because it is tied to an actual outstanding Discord message:
 * it survives `forwardedPermissionIds` pruning, SSE redelivery, and reconcile
 * re-forwarding. Without it, a single permission whose id briefly drops out of
 * the pending-list snapshot used to spawn a brand-new approval message on every
 * reconcile cycle (the "approvals duplicated many times" bug).
 */
function hasLiveApprovalForRequest(requestID) {
  if (!requestID) return false;
  for (const ctx of approvalContexts.values()) {
    if (ctx && typeof ctx === 'object' && ctx.requestID === requestID) return true;
  }
  return false;
}

/**
 * Post an approval-request message with Approve / Deny buttons.
 * Returns { ok, approvalId, messageId } or { ok, error }.
 */
async function sendApprovalToSurface({ type, token, channelId, threadId, permission, directory }) {
  const approvalId = generateApprovalId();
  const tool = String(permission?.permission ?? 'approval');
  const contextStr = renderPermissionContext(permission);
  const preamble = `⚠️ **Permission Required** — \`${escapeMd(tool)}\``;
  const content = contextStr
    ? `${preamble}\n\n${contextStr}`
    : `⚠️ **Permission Required** — \`${escapeMd(tool)}\``;

  // Always show 3 buttons: Approve (once), Always Allow, Deny
  // matching the web UI's PermissionCard behavior
  const alwaysStr = Array.isArray(permission?.always) && permission.always.length > 0
    ? permission.always.slice(0, 2).join(', ') + (permission.always.length > 2 ? '…' : '')
    : '';

  // Helper to store and auto-expire approval context
  const storeApprovalContext = (extra = {}) => {
    approvalContexts.set(approvalId, {
      sessionID: permission?.sessionID,
      requestID: permission?.id,
      directory: directory || permission?.metadata?.directory || null,
      sdkDirectory: permission?.metadata?.sdkDirectory || directory || null,
      createdAt: Date.now(),
      ...extra,
    });
    setTimeout(() => approvalContexts.delete(approvalId), 10 * 60 * 1000).unref();
  };

  if (type === 'discord') {
    // Build Discord buttons: Approve, Always Allow, Deny
    const buttons = [
      { type: 2, style: 3, label: '✅ Allow Once', custom_id: `otto-approve:${approvalId}` },
      { type: 2, style: 2, label: alwaysStr ? `Always: ${alwaysStr}` : '♻️ Always Allow', custom_id: `otto-approve-always:${approvalId}` },
      { type: 2, style: 4, label: '❌ Deny', custom_id: `otto-deny:${approvalId}` },
    ];

    const ch = threadId ?? channelId;
    const r = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(ch)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.slice(0, DISCORD_LIMIT),
          components: [{ type: 1, components: buttons }],
        }),
      },
    );
    if (!r.ok) {
      console.error('[BRIDGE] Failed to send approval to Discord:', r.status, (await r.text()).slice(0, 200));
      return { ok: false, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    // Only store context after the Discord API call succeeds. The surface
    // info lets the bridge auto-reject + strip buttons when a new message
    // supersedes the pending request.
    const data = await r.json();
    storeApprovalContext({
      surface: { type, token, channelId: ch, messageId: data?.id ?? null },
    });
    return { ok: true, approvalId, messageId: data.id };
  }

  return { ok: false, error: `Unsupported messenger type: ${type}` };
}

// ── Question flow helpers ─────────────────────────────────────────────
// Maps questionId → { sessionID, requestID, directory, questions, answers,
// surface } so option clicks (and typed replies) can be routed back to
// OpenCode's question.reply API. Mirrors the permission approvalContexts.
export const questionContexts = new Map();

const QUESTION_CONTEXT_TTL_MS = 30 * 60 * 1000;

/** Build the interactive Discord components for one question. */
function buildQuestionComponents({ questionId, questionIndex, question }) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length === 0) return [];
  const multiple = Boolean(question?.multiple);

  // Up to 5 single-select options fit as one row of buttons; anything
  // bigger (or multi-select) becomes a select menu (max 25 options).
  if (!multiple && options.length <= 5) {
    return [
      {
        type: 1,
        components: options.map((opt, i) => ({
          type: 2,
          style: 2,
          label: clipBlock(`${i + 1}. ${typeof opt?.label === 'string' && opt.label.trim() ? opt.label.trim() : `Option ${i + 1}`}`, 80),
          custom_id: `otto-question:${questionId}:${questionIndex}:${i}`,
        })),
      },
    ];
  }

  const selectOptions = options.slice(0, 25).map((opt, i) => {
    const label = typeof opt?.label === 'string' && opt.label.trim() ? opt.label.trim() : `Option ${i + 1}`;
    const description = typeof opt?.description === 'string' ? opt.description.trim() : '';
    return {
      label: clipBlock(label, 100),
      value: String(i),
      ...(description ? { description: clipBlock(description, 100) } : {}),
    };
  });
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `otto-question-select:${questionId}:${questionIndex}`,
          options: selectOptions,
          min_values: 1,
          max_values: multiple ? selectOptions.length : 1,
          placeholder: multiple ? 'Select one or more options' : 'Select an option',
        },
      ],
    },
  ];
}

/** PATCH a Discord message (used to edit todo lists / strip stale components). */
async function editDiscordMessage({ token, channelId, messageId, content, components }) {
  const body = {};
  if (typeof content === 'string') body.content = content.slice(0, DISCORD_LIMIT);
  if (components !== undefined) body.components = components;
  try {
    const r = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) return { ok: false, status: r.status, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message ?? 'Discord PATCH failed' };
  }
}

/**
 * Add a Discord user to a thread so it shows up under the channel for them
 * immediately (Discord only lists threads in the channel sidebar for members).
 * Best-effort: a failure here never breaks thread creation — the user can still
 * open the thread manually. `userIds` may be a single id or an array of ids.
 */
async function addThreadMembers({ token, threadId, userIds }) {
  if (!threadId || !userIds) return;
  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .map((id) => (id == null ? '' : String(id).trim()))
    .filter(Boolean);
  for (const userId of ids) {
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(threadId)}/thread-members/${encodeURIComponent(userId)}`,
        { method: 'PUT', headers: { Authorization: `Bot ${token}` } },
      );
      if (!r.ok) {
        console.warn(
          `[BRIDGE] Failed to add user ${userId} to thread ${threadId}: Discord ${r.status} — ${(await r.text()).slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(`[BRIDGE] Failed to add user ${userId} to thread ${threadId}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Create a public Discord thread starting from a user's message. Returns
 * the new thread id, or null when the API call failed (we fall back to
 * the channel in that case so the user still gets a reply).
 *
 * When `userId` is provided, the user is added to the thread immediately
 * so the thread shows up under the channel for them (Discord only shows
 * threads in the channel list for members).
 */
async function startDiscordThread({ token, channelId, messageId, name, userId }) {
  if (!messageId) return { ok: false, error: 'no source message id' };
  const safeName = (name || 'OpenChamber agent').replace(/\s+/g, ' ').slice(0, 80) || 'OpenChamber agent';
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
    {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName, auto_archive_duration: 1440 }),
    },
  );
  if (!r.ok) return { ok: false, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data = await r.json();
  const threadId = data.id ?? null;
  if (threadId && userId) await addThreadMembers({ token, threadId, userIds: userId });
  return { ok: true, threadId: threadId ?? null, threadName: data.name ?? safeName };
}

/**
 * Create a Discord thread that is NOT anchored to an existing message
 * (the "Start Thread without Message" endpoint). Used to give each web-UI
 * conversation its own thread inside the project channel, so the channel feed
 * stays clean. type 11 = GUILD_PUBLIC_THREAD. Returns the new thread id or an
 * error (callers fall back to posting in the channel itself).
 */
async function startStandaloneDiscordThread({ token, channelId, name, userIds }) {
  const safeName = (name || 'OpenChamber agent').replace(/\s+/g, ' ').slice(0, 90) || 'OpenChamber agent';
  const r = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/threads`,
    {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName, type: 11, auto_archive_duration: 1440 }),
    },
  );
  if (!r.ok) return { ok: false, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data = await r.json();
  const threadId = data.id ?? null;
  // A web-UI conversation has no Discord author to anchor on, so the thread
  // would otherwise stay invisible in the channel sidebar for the human owner.
  // Add the configured owner id(s) so the thread shows up for them immediately.
  if (threadId && userIds) await addThreadMembers({ token, threadId, userIds });
  return { ok: true, threadId, threadName: data.name ?? safeName };
}

/**
 * Delete a Discord thread (DELETE /channels/:id). Best-effort: a 404 (already
 * gone) is treated as success. Used when an OpenCode session is deleted in the
 * web UI so the bound thread disappears from Discord too.
 */
async function deleteDiscordThread({ token, threadId }) {
  if (!threadId) return { ok: false, error: 'no thread id' };
  try {
    const r = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(threadId)}`,
      { method: 'DELETE', headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(5000) },
    );
    if (r.ok || r.status === 404) return { ok: true };
    return { ok: false, error: `Discord ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'thread delete failed' };
  }
}

async function discordTyping({ token, channelId }) {
  try {
    await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}` },
    });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export function createMessengerOpencodeBridge({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastEvent,
  store,
  listProjects,
  /**
   * Optional bootstrap handler called when an unbound channel sends a
   * `clone <url>` / `path <abs>` / `new <label>` reply. Signature:
   *   ({ action, url?, path?, label? }) => { ok, project?: { id, path, label }, error? }
   * If unset, the bridge falls back to slug-matching / first-project.
   */
  bootstrapProject = null,
  /**
   * Optional lookup function for reverse-mapping a session ID to a
   * messenger surface. Used by the permission.asked handler when the
   * session is not tracked locally (e.g. gateway bot handles inbound).
   * Signature: (sessionId) => { type, token, targetKey, threadId?, projectPath? } | null
   */
  lookupMessengerTarget = null,
  /**
   * Optional accessor for the OpenChamber-wide defaults the rest of the UI
   * uses (Settings → Defaults). Lets the messenger fall back to the SAME
   * default model/agent the web chat uses instead of whatever OpenCode would
   * pick on its own. Signature: () => { model?: string|null, agent?: string|null }
   * (may be async).
   */
  getGlobalDefaults = null,
  /**
   * Optional settings reader (async () => settings object). Used for the
   * voice-message STT configuration (sttServerUrl / sttModel / sttLanguage)
   * and for resolving the bot token when scheduled tasks fire.
   */
  readSettings = null,
  /**
   * Optional settings writer (async (partial) => void). Used to keep
   * settings.discord.projectBindings in sync when a project's Discord channel
   * is renamed or deleted IN Discord (the two-way half of project↔channel sync).
   */
  persistSettings = null,
  /**
   * Optional base URL of this OpenChamber server (e.g. http://127.0.0.1:3001).
   * Injected into new sessions so the agent can self-serve scheduling via the
   * local HTTP API.
   */
  getLocalApiBaseUrl = null,
  /**
   * Optional default messenger target for web-originated OpenCode sessions.
   * Discord-originated sessions already have a bound context; this
   * lets unbound web UI sessions mirror into the configured messenger space.
   * Signature: ({ sessionId, projectPath }) => { type, token, channelId, threadId?, projectPath? } | null
   */
  getDefaultMessengerTarget = null,
  /**
   * Optional accessor for the locally-discovered skills available to the agent
   * in a given project. Powers the Discord `/skill` picker. Signature:
   *   ({ projectPath }) => Array<{ name, description?, scope?, source? }> (sync or async)
   */
  listSkills = null,
  /**
   * OpenChamber's per-project config runtime (scheduled task persistence).
   * The Discord `/schedule` command creates tasks HERE — the same store the
   * Scheduled-tasks dialog in the web UI uses — so both stay in sync.
   */
  projectConfigRuntime = null,
  /**
   * OpenChamber's scheduled-tasks runtime. Used to re-sync a project's
   * timers after the Discord `/schedule` command mutates its tasks.
   */
  scheduledTasksRuntime = null,
}) {
  const bridgeStore = store ?? new MessengerBridgeStore();

  /**
   * Resolve the OpenChamber-wide default model/agent (Settings → Defaults).
   * Best-effort: returns `{ model: null, agent: null }` when unavailable so
   * callers can fall through to OpenCode's own default.
   */
  /**
   * Resolve a concrete, valid agent name for OpenCode's shell endpoint.
   *
   * Unlike `/session/:id/prompt_async` (where omitting the agent lets OpenCode
   * pick its default), `/session/:id/shell` REQUIRES a real agent — an empty or
   * unknown agent returns HTTP 500 and the command never runs. So we resolve in
   * priority order and, when nothing is configured, discover an actual primary
   * agent from the server instead of guessing. Falls back to `build` (OpenCode's
   * stock primary agent) only as a last resort.
   */
  async function resolveShellAgent({ surfaceAgent = null, projectAgent = null, globalAgent = null } = {}) {
    const configured = surfaceAgent || projectAgent || globalAgent || null;
    if (configured) return configured;
    try {
      const agents = await opencodeAdapter.listAgents();
      const visible = (Array.isArray(agents) ? agents : []).filter((a) => a && a.name && !a.hidden);
      const primaries = visible.filter((a) => a.mode !== 'subagent' && a.mode !== 'sub');
      const build =
        primaries.find((a) => a.name === 'build') || visible.find((a) => a.name === 'build');
      if (build) return build.name;
      if (primaries.length > 0) return primaries[0].name;
      if (visible.length > 0) return visible[0].name;
    } catch {
      // fall through to the stock default
    }
    return 'build';
  }

  async function resolveGlobalDefaults() {
    if (!getGlobalDefaults) return { model: null, agent: null, variant: null };
    try {
      const d = await getGlobalDefaults();
      const model =
        typeof d?.model === 'string' && /^[^/]+\/[^/]+$/.test(d.model.trim())
          ? d.model.trim()
          : null;
      const agent = typeof d?.agent === 'string' && d.agent.trim() ? d.agent.trim() : null;
      const variant = typeof d?.variant === 'string' && d.variant.trim() ? d.variant.trim() : null;
      return { model, agent, variant };
    } catch {
      return { model: null, agent: null, variant: null };
    }
  }

  // Per-session live context. Holds the messenger surface (channel/thread)
  // OpenCode events should be routed to, and the set of part ids we've
  // already posted (so we don't double-post on partial-update events).
  /** @type {Map<string, {
   *   type: 'discord',
   *   token: string,
   *   channelId: string,
   *   threadId: string|null,
   *   sentPartIds: Set<string>,
   *   typingTimer?: NodeJS.Timeout,
   *   startedAt: number,
   *   lastError: string|null,
   * }>}
   */
  const sessionContexts = new Map();

  // --- /queue support ------------------------------------------------------
  // Sessions with an in-flight assistant turn. Set when a prompt is sent,
  // cleared on session.idle / session.error so `/queue` knows whether to
  // hold a message back or send it immediately.
  /** @type {Set<string>} */
  const busySessions = new Set();
  // surfaceKey → queued messages, drained one-by-one on session.idle.
  /** @type {Map<string, Array<{ text: string, from?: object, queuedAt: number }>>} */
  const surfaceQueues = new Map();
  const MAX_QUEUE_LENGTH = 16;

  function queueKeyFor({ type, channelId, threadId }) {
    return `${type}:${channelId}:${threadId ?? ''}`;
  }

  // --- supersede support ---------------------------------------------------
  // A plain (non-/queue) message cancels any in-flight turn and runs straight
  // away — /queue is the opt-in "wait your turn" path. Because OpenCode's abort
  // settles asynchronously (session.idle / session.error over SSE), we stash
  // the superseding send here and fire it only once the aborted turn settles,
  // so its idle event can't clear `busySessions` out from under the new turn.
  /** @type {Map<string, () => Promise<unknown>>} */
  const pendingSupersede = new Map();
  const SUPERSEDE_FALLBACK_MS = 8000;
  // After a turn is superseded, OpenCode may emit a trailing abort `session.error`
  // (e.g. "streaming response failed" / "provider not available") for the turn we
  // just cancelled. If it lands AFTER the stashed send already fired (so it's no
  // longer in `pendingSupersede`), suppress it within this grace window instead of
  // surfacing the teardown of a turn the user intentionally interrupted.
  const SUPERSEDE_ERROR_GRACE_MS = 6000;

  /** Run (and clear) a stashed superseding send for a session, if any. */
  function runSupersede(sessionId, ctx) {
    const resume = pendingSupersede.get(sessionId);
    if (!resume) return false;
    pendingSupersede.delete(sessionId);
    if (ctx) {
      ctx.sentPartIds.clear();
      ctx.startedAt = Date.now();
      // The resumed turn is now the active one — clear stale error/idle flags,
      // remember when we superseded (grace window for the aborted turn's late
      // error), and re-arm the typing pulse so the bot never looks unresponsive.
      ctx.errored = false;
      ctx.idleSettled = false;
      ctx.supersededAt = Date.now();
      startTypingPulse(ctx);
    }
    busySessions.delete(sessionId);
    void resume();
    return true;
  }

  /**
   * Safety net for the supersede path: if OpenCode never emits idle/error for
   * the aborted turn, run the stashed send anyway after a short grace period so
   * the user's new message is never stranded.
   */
  function scheduleSupersedeFallback(sessionId) {
    const timer = setTimeout(() => {
      if (pendingSupersede.has(sessionId)) {
        runSupersede(sessionId, sessionContexts.get(sessionId));
      }
    }, SUPERSEDE_FALLBACK_MS);
    timer.unref?.();
  }

  // Last user prompt per surface, so the `/model` wizard's "Send last message"
  // button can replay it under the freshly-chosen model. Keyed by the same
  // token-scoped surface key the bindings use (thread id when in a thread, else
  // channel id) so the wizard — which runs in the conversation channel — finds
  // it regardless of how the thread was spawned. Bounded.
  /** @type {Map<string, string>} */
  const lastPromptBySurface = new Map();
  const LAST_PROMPT_CACHE_MAX = 500;
  function lastPromptKey({ type, token, channelId, threadId }) {
    return `${tokenHash(token)}:${targetKey({ type, channelId, threadId: threadId ?? null })}`;
  }
  function rememberLastPrompt(surface, text) {
    if (!text || typeof text !== 'string') return;
    const key = lastPromptKey(surface);
    if (!lastPromptBySurface.has(key) && lastPromptBySurface.size >= LAST_PROMPT_CACHE_MAX) {
      const oldest = lastPromptBySurface.keys().next().value;
      if (oldest !== undefined) lastPromptBySurface.delete(oldest);
    }
    lastPromptBySurface.set(key, text);
  }

  // messageID → role ('user' | 'assistant'). OpenCode's `message.part.updated`
  // events do NOT carry the message role — it lives on the separate
  // `message.updated` event (`properties.info.role`). We cache it here so the
  // part handler can tell a user's own prompt apart from assistant output and
  // mirror the former into the messenger as a **Web** block. Bounded so it can
  // never grow without limit on a long-lived server.
  /** @type {Map<string, 'user'|'assistant'>} */
  const messageRoles = new Map();
  const MESSAGE_ROLE_CACHE_MAX = 2000;
  function rememberMessageRole(messageId, role) {
    if (!messageId || (role !== 'user' && role !== 'assistant')) return;
    if (messageRoles.has(messageId)) {
      messageRoles.set(messageId, role);
      return;
    }
    if (messageRoles.size >= MESSAGE_ROLE_CACHE_MAX) {
      // Drop the oldest entry (insertion order) to keep the cache bounded.
      const oldest = messageRoles.keys().next().value;
      if (oldest !== undefined) messageRoles.delete(oldest);
    }
    messageRoles.set(messageId, role);
  }
  // messageID → parentID. OpenCode sets an assistant message's `parentID` to
  // the user message that triggered it. We use it to recognise the assistant
  // "echo" of a user-run shell command (`/shell` / web `!cmd`): that echo's
  // parent is the synthetic user message carrying the shell marker. Bounded.
  /** @type {Map<string, string>} */
  const messageParents = new Map();
  const MESSAGE_PARENT_CACHE_MAX = 2000;
  function rememberMessageParent(messageId, parentId) {
    if (!messageId || typeof parentId !== 'string' || !parentId) return;
    if (messageParents.has(messageId)) {
      messageParents.set(messageId, parentId);
      return;
    }
    if (messageParents.size >= MESSAGE_PARENT_CACHE_MAX) {
      const oldest = messageParents.keys().next().value;
      if (oldest !== undefined) messageParents.delete(oldest);
    }
    messageParents.set(messageId, parentId);
  }

  // User messages whose text is the shell marker ("The following tool was
  // executed by the user"). Their assistant child carries the bash tool with
  // the command + output that we render as a clean shell block. Bounded set.
  /** @type {Set<string>} */
  const shellMarkerMessageIds = new Set();
  const SHELL_MARKER_CACHE_MAX = 1000;
  function rememberShellMarkerMessage(messageId) {
    if (!messageId) return;
    if (shellMarkerMessageIds.has(messageId)) return;
    if (shellMarkerMessageIds.size >= SHELL_MARKER_CACHE_MAX) {
      const oldest = shellMarkerMessageIds.values().next().value;
      if (oldest !== undefined) shellMarkerMessageIds.delete(oldest);
    }
    shellMarkerMessageIds.add(messageId);
  }

  /**
   * Detect the assistant message that OpenCode emits as the result of a
   * user-run shell command. Such a message's `parentID` is the synthetic user
   * message that carried the shell marker. Returns the bash command/output/
   * status when the given tool part is that echo, otherwise null.
   */
  function getUserShellEcho(part) {
    if (!part || part.type !== 'tool') return null;
    const tool = String(part.tool ?? '').toLowerCase();
    if (tool !== 'bash' && tool !== 'shell') return null;
    const messageId = getPartMessageId(part);
    if (!messageId) return null;
    const parentId = messageParents.get(messageId);
    if (!parentId || !shellMarkerMessageIds.has(parentId)) return null;
    const state = part.state ?? {};
    const command = typeof state.input?.command === 'string' ? state.input.command : '';
    const output =
      (typeof state.output === 'string' ? state.output : '') ||
      (typeof state.metadata?.output === 'string' ? state.metadata.output : '');
    const status = typeof state.status === 'string' ? state.status : '';
    return { command, output, status };
  }

  function getMessageId(value) {
    return value?.id ?? value?.messageID ?? value?.messageId ?? value?.message?.id ?? value?.message?.messageID ?? value?.message?.messageId ?? null;
  }

  function getPartMessageId(part) {
    return part?.messageID ?? part?.messageId ?? part?.message?.id ?? part?.message?.messageID ?? part?.message?.messageId ?? null;
  }

  function getPartSessionId(part, props) {
    return (
      part?.sessionID ??
      part?.sessionId ??
      part?.session?.id ??
      part?.message?.sessionID ??
      part?.message?.sessionId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session?.id ??
      props?.message?.sessionID ??
      props?.message?.sessionId ??
      null
    );
  }

  /**
   * Resolve a part's message role. OpenCode has used multiple payload shapes:
   * role may live on the part, on a nested message, or only on message.updated.
   */
  function resolvePartRole(part, props = null) {
    const role = part?.role ?? part?.message?.role ?? props?.role ?? props?.message?.role ?? null;
    if (role === 'user' || role === 'assistant') return role;
    const messageId = getPartMessageId(part);
    if (messageId && messageRoles.has(messageId)) return messageRoles.get(messageId);
    return null;
  }

  // Part events may arrive before the matching message.updated event that
  // declares the message role. Keep the latest part briefly, keyed by messageID,
  // then replay it once the role arrives.
  /** @type {Map<string, { part: object, projectPath: string|null }>} */
  const pendingPartsByMessageId = new Map();
  const PENDING_PART_CACHE_MAX = 2000;
  function rememberPendingPart(part, projectPath) {
    const messageId = getPartMessageId(part);
    if (!messageId) return;
    if (!pendingPartsByMessageId.has(messageId) && pendingPartsByMessageId.size >= PENDING_PART_CACHE_MAX) {
      const oldest = pendingPartsByMessageId.keys().next().value;
      if (oldest !== undefined) pendingPartsByMessageId.delete(oldest);
    }
    pendingPartsByMessageId.set(messageId, { part, projectPath });
  }

  // Guards against creating two threads / contexts for the same session when
  // the user and assistant parts arrive nearly simultaneously.
  /** @type {Map<string, Promise<object|null>>} */
  const pendingContextCreations = new Map();

  // Prompts that arrived FROM a messenger (Discord inbound). OpenCode
  // echoes every prompt back as a `user` part; when the session also mirrors web
  // activity into the messenger (a thread that was created from the web UI but is
  // later answered from Discord), that echo would re-post the user's own message
  // right back at them. We remember each inbound prompt per session and consume
  // the matching `user` part so it is never mirrored back to its own author.
  /** @type {Map<string, string[]>} */
  const messengerInboundPrompts = new Map();
  const MESSENGER_INBOUND_CACHE_MAX = 200;
  function rememberMessengerInbound(sessionId, text) {
    if (!sessionId || typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const queue = messengerInboundPrompts.get(sessionId) ?? [];
    queue.push(trimmed);
    // Bound per-session queue so a chatty session can't grow it without limit.
    if (queue.length > 16) queue.splice(0, queue.length - 16);
    messengerInboundPrompts.set(sessionId, queue);
    if (messengerInboundPrompts.size > MESSENGER_INBOUND_CACHE_MAX) {
      const oldest = messengerInboundPrompts.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) messengerInboundPrompts.delete(oldest);
    }
  }
  /** Consume a remembered inbound prompt; returns true when the text matched. */
  function consumeMessengerInbound(sessionId, text) {
    if (!sessionId || typeof text !== 'string') return false;
    const queue = messengerInboundPrompts.get(sessionId);
    if (!queue || queue.length === 0) return false;
    const trimmed = text.trim();
    const idx = queue.indexOf(trimmed);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    if (queue.length === 0) messengerInboundPrompts.delete(sessionId);
    return true;
  }

  // Per-surface project bootstrap dialogue state. When a new channel sends
  // its first message and we have no slug-match (and the user has not yet
  // told us what project this channel maps to), we stash the original
  // text here and ask "clone | path | new". The follow-up reply lands here
  // and triggers the bootstrap.
  /** @type {Map<string, { type, token, channelId, threadId, sourceMessageId, originalText, askedAt }>} */
  const bootstrapPending = new Map();

  /**
   * Bootstrap dialogue key — uses the same Discord-aware semantics as
   * targetKey so the first message's stash and the user's reply (which
   * arrives with `channel_id = thread_id` on Discord) land on the same
   * surface.
   */
  function bootstrapKey({ type, channelId, threadId }) {
    return `${type}:${targetKey({ type, channelId, threadId })}`;
  }

  /**
   * Parse a user's bootstrap reply. Returns `{ action, url?, path?, label? }`
   * or null when the message isn't a bootstrap command.
   */
  function parseBootstrapReply(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^(clone|path|new)\s+(.+)$/i);
    if (!m) return null;
    const action = m[1].toLowerCase();
    const rest = m[2].trim();
    if (action === 'clone') return { action: 'clone', url: rest };
    if (action === 'path') return { action: 'path', path: rest };
    if (action === 'new') return { action: 'new', label: rest };
    return null;
  }

  // Cache: target name lookups (for slug-matching projects).
  const nameCache = new Map();

  async function lookupTargetName({ type, token, channelId, threadId }) {
    const key = `${type}:${channelId}${threadId ? `:${threadId}` : ''}`;
    const cached = nameCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    let name = null;
    try {
      if (type === 'discord') {
        const lookupId = threadId ?? channelId;
        const r = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(lookupId)}`,
          { headers: { Authorization: `Bot ${token}` } },
        );
        if (r.ok) {
          const data = await r.json();
          name = data.name ?? null;
        }
      }
    } catch {
      // ignore
    }
    nameCache.set(key, { name, expiresAt: Date.now() + NAME_TTL_MS });
    return name;
  }

  async function autoResolveProject({ type, token, channelId, threadId }) {
    if (!listProjects) return null;
    let projects = [];
    try {
      projects = (await listProjects()) ?? [];
    } catch {
      return null;
    }
    if (!Array.isArray(projects) || projects.length === 0) return null;
    // Slug-match on the parent CHANNEL name, never the per-conversation thread.
    // The project↔channel mapping is keyed by channel; a freshly spawned
    // thread is named after the user's first message, which would never
    // slug-match a project and collapsed every channel onto the first project.
    const name = await lookupTargetName({ type, token, channelId, threadId: null });
    const matched = pickProjectForName(projects, name);
    const project = matched ?? projects[0];
    if (!project?.path) return null;
    return {
      projectPath: project.path,
      projectLabel: project.label ?? project.path.split('/').pop() ?? project.path,
      autoResolved: !matched ? 'fallback-first' : 'slug-match',
      resolvedFromName: name,
    };
  }

  // --- OpenCode REST ------------------------------------------------------
  async function opencodeFetch(pathSuffix, init = {}) {
    const url = buildOpenCodeUrl(pathSuffix, '');
    const headers = {
      ...(init.headers ?? {}),
      ...(getOpenCodeAuthHeaders?.() ?? {}),
      'Content-Type': 'application/json',
    };
    return fetch(url, { ...init, headers });
  }

  async function createOpencodeSession({ projectPath, title = null }) {
    const params = projectPath ? `?directory=${encodeURIComponent(projectPath)}` : '';
    // Omit the title by default so OpenCode auto-generates a meaningful
    // summary title from the conversation. The bridge then
    // renames the Discord thread to match on session.updated.
    const r = await opencodeFetch(`/session${params}`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`OpenCode session create ${r.status}: ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    return data?.id ?? data?.sessionID ?? data?.session_id ?? data;
  }

  async function sendOpencodePrompt({ sessionId, projectPath, text, modelOverride, agentOverride, variantOverride, extraParts = [] }) {
    const params = projectPath ? `?directory=${encodeURIComponent(projectPath)}` : '';
    const parts = [{ type: 'text', text }];
    for (const part of extraParts) {
      if (part && typeof part === 'object') parts.push(part);
    }
    const body = { parts };
    if (modelOverride && /^[^/]+\/[^/]+$/.test(modelOverride)) {
      const [providerID, ...rest] = modelOverride.split('/');
      body.model = { providerID, modelID: rest.join('/') };
      // Thinking-effort: OpenCode reads the reasoning variant off `model.variant`
      // (same field the web chat sends). Only attach it when a model is set.
      if (variantOverride && typeof variantOverride === 'string') {
        body.model.variant = variantOverride;
      }
    }
    if (agentOverride) body.agent = agentOverride;
    const r = await opencodeFetch(
      `/session/${encodeURIComponent(sessionId)}/prompt_async${params}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`OpenCode prompt ${r.status}: ${errText.slice(0, 300)}`);
    }
    busySessions.add(sessionId);
    return true;
  }

  /**
   * Small adapter exposed to the messenger-command handlers so they can
   * talk to OpenCode without re-implementing the auth/url plumbing.
   */
  const opencodeAdapter = {
    async listProviders() {
      const r = await opencodeFetch('/provider');
      if (!r.ok) return [];
      const d = await r.json().catch(() => null);
      // OpenCode returns { location, data: [...] } (w/ /api prefix),
      // { all: [...], default: ..., connected: [...] } (w/o /api prefix),
      // { providers: [...] }, or a bare array on older versions — be defensive.
      const raw = Array.isArray(d) ? d
        : Array.isArray(d?.data) ? d.data
        : Array.isArray(d?.all) ? d.all
        : Array.isArray(d?.providers) ? d.providers
        : [];
      return raw.map((p) => ({
        id: p.id ?? p.name,
        name: p.name ?? p.id,
        models: Array.isArray(p.models)
          ? p.models.map((m) => ({ id: m.id ?? m.name, name: m.name ?? m.id }))
          : [],
      }));
    },
    async listAgents() {
      const r = await opencodeFetch('/agent');
      if (!r.ok) return [];
      const d = await r.json().catch(() => null);
      const raw = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.agents) ? d.agents : [];
      return raw.map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
        hidden: Boolean(a.hidden),
        mode: a.mode,
      }));
    },
    async listSessions(directory) {
      const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const r = await opencodeFetch(`/session${params}`);
      if (!r.ok) return [];
      const d = await r.json().catch(() => null);
      const raw = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.sessions) ? d.sessions : [];
      return raw;
    },
    async abortSession(sessionId, directory) {
      try {
        // Some OpenCode API versions require directory as query param
        const query = directory && typeof directory === 'string' && directory.length > 0
          ? `?directory=${encodeURIComponent(directory)}`
          : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/abort${query}`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'abort failed' };
      }
    },
    async revertSession(sessionId, messageId) {
      try {
        const body = messageId ? { messageID: messageId } : {};
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/revert`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'revert failed' };
      }
    },
    async unrevertSession(sessionId) {
      try {
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/unrevert`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'unrevert failed' };
      }
    },
    async summarizeSession(sessionId, modelRef) {
      try {
        const body = {};
        if (modelRef && /^[^/]+\/[^/]+$/.test(modelRef)) {
          const [providerID, ...rest] = modelRef.split('/');
          body.providerID = providerID;
          body.modelID = rest.join('/');
        }
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/summarize`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'summarize failed' };
      }
    },
    async sendOpencodeCommand(sessionId, name, argsText) {
      try {
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/command`, {
          method: 'POST',
          body: JSON.stringify({ command: name, arguments: argsText ?? '' }),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'command failed' };
      }
    },
    async sendPrompt(sessionId, projectPath, text) {
      try {
        await sendOpencodePrompt({ sessionId, projectPath, text });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'prompt failed' };
      }
    },
    async runShell(sessionId, projectPath, command, { modelOverride = null, agentOverride = null } = {}) {
      try {
        // OpenCode's shell endpoint requires a real agent — an empty or unknown
        // agent returns HTTP 500 and the command silently never runs. Callers
        // resolve a concrete agent (see resolveShellAgent); guard here too so a
        // future caller can't reintroduce the 500.
        if (!agentOverride) {
          return { ok: false, error: 'no agent resolved for shell command' };
        }
        const params = projectPath ? `?directory=${encodeURIComponent(projectPath)}` : '';
        const body = { command, agent: agentOverride };
        if (modelOverride && /^[^/]+\/[^/]+$/.test(modelOverride)) {
          const [providerID, ...rest] = modelOverride.split('/');
          body.model = { providerID, modelID: rest.join('/') };
        }
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/shell${params}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        // The command runs server-side; its command + output stream back as a
        // bash tool part on the returned assistant message and are mirrored to
        // the surface by emitPart (rendered via renderUserShellResult).
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'shell command failed' };
      }
    },
    async listSkills(projectPath) {
      if (typeof listSkills !== 'function') return [];
      try {
        const skills = await listSkills({ projectPath: projectPath ?? null });
        return Array.isArray(skills) ? skills : [];
      } catch {
        return [];
      }
    },
    async shareSession(sessionId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/share${params}`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        const d = await r.json().catch(() => null);
        return { ok: true, url: d?.share?.url ?? d?.url ?? null };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'share failed' };
      }
    },
    async unshareSession(sessionId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/share${params}`, {
          method: 'DELETE',
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'unshare failed' };
      }
    },
    async forkSession(sessionId, messageId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const body = messageId ? { messageID: messageId } : {};
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/fork${params}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        const d = await r.json().catch(() => null);
        const newId = d?.id ?? d?.sessionID ?? null;
        if (!newId) return { ok: false, error: 'fork returned no session id' };
        return { ok: true, sessionId: newId, title: d?.title ?? null };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'fork failed' };
      }
    },
    async listMessages(sessionId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/message${params}`);
        if (!r.ok) return [];
        const d = await r.json().catch(() => null);
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      } catch {
        return [];
      }
    },
    async getSession(sessionId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}${params}`);
        if (!r.ok) return null;
        return await r.json().catch(() => null);
      } catch {
        return null;
      }
    },
    async deleteSession(sessionId, directory) {
      try {
        const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}${params}`, {
          method: 'DELETE',
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message ?? 'delete failed' };
      }
    },
  };

  // --- Session resolution -------------------------------------------------
  async function resolveOrCreateSession({ type, token, channelId, threadId, projectPath, projectLabel }) {
    const hash = tokenHash(token);
    const key = targetKey({ type, channelId, threadId });
    const existing = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: key });
    if (existing?.sessionId) {
      bridgeStore.touch({ type, botTokenHash: hash, targetKey: key });
      return { sessionId: existing.sessionId, projectPath: existing.projectPath, autoResolved: 'cached', created: false };
    }

    let effectivePath = projectPath ?? null;
    let effectiveLabel = projectLabel ?? null;
    let autoResolved = null;
    let resolvedFromName = null;
    if (!effectivePath) {
      const auto = await autoResolveProject({ type, token, channelId, threadId });
      if (auto) {
        effectivePath = auto.projectPath;
        effectiveLabel = auto.projectLabel;
        autoResolved = auto.autoResolved;
        resolvedFromName = auto.resolvedFromName;
      }
    }

    // No explicit title — OpenCode auto-generates one from the first
    // message and the bridge renames the Discord thread to match.
    const sessionId = await createOpencodeSession({ projectPath: effectivePath });
    bridgeStore.bind({
      type,
      botTokenHash: hash,
      targetKey: key,
      sessionId,
      projectPath: effectivePath,
      projectLabel: effectiveLabel,
    });
    broadcastEvent?.('messenger.bridge.session_bound', {
      type,
      channelId,
      threadId,
      sessionId,
      projectPath: effectivePath,
      projectLabel: effectiveLabel,
      autoResolved,
      resolvedFromName,
    });
    return { sessionId, projectPath: effectivePath, autoResolved, created: true };
  }

  // --- Project memory (MEMORY.md) -------------------------------------------
  // When a brand-new session starts, the project's MEMORY.md (if present) is
  // injected into the first prompt as a <project-memory> block so persistent
  // context survives across sessions.
  const MEMORY_FILE_NAME = 'MEMORY.md';
  const MEMORY_MAX_CHARS = 12_000;
  async function readProjectMemory(projectPath) {
    if (!projectPath) return null;
    try {
      const filePath = path.join(projectPath, MEMORY_FILE_NAME);
      const raw = await fs.readFile(filePath, 'utf8');
      const trimmed = raw.trim();
      if (!trimmed) return null;
      return trimmed.length > MEMORY_MAX_CHARS
        ? trimmed.slice(0, MEMORY_MAX_CHARS) + '\n…(truncated)'
        : trimmed;
    } catch {
      return null;
    }
  }

  // --- Voice transcription ---------------------------------------------------
  // Proxies Discord voice-message audio to the same OpenAI-compatible STT
  // endpoint OpenChamber's web UI uses (Settings → Voice → Custom server).
  async function transcribeVoiceAttachment({ audioBuffer, mimeType }) {
    if (typeof readSettings !== 'function') return null;
    let settings = null;
    try {
      settings = await readSettings();
    } catch {
      return null;
    }
    const baseURL = typeof settings?.sttServerUrl === 'string' ? settings.sttServerUrl.trim() : '';
    if (!baseURL) return null;
    const model =
      typeof settings?.sttModel === 'string' && settings.sttModel.trim().length > 0
        ? settings.sttModel.trim()
        : 'deepdml/faster-whisper-large-v3-turbo-ct2';
    const language =
      typeof settings?.sttLanguage === 'string' && settings.sttLanguage.trim().length > 0
        ? settings.sttLanguage.trim()
        : undefined;
    const { transcribeAudio } = await import('../tts/stt.js');
    return transcribeAudio({ audioBuffer, mimeType, model, baseURL, language });
  }

  async function isSttConfigured() {
    if (typeof readSettings !== 'function') return false;
    try {
      const settings = await readSettings();
      return typeof settings?.sttServerUrl === 'string' && settings.sttServerUrl.trim().length > 0;
    } catch {
      return false;
    }
  }

  // --- Mention-only mode ------------------------------------------------------
  function mentionModeKey({ type, token, channelId }) {
    return `mention-mode:${type}:${tokenHash(token)}:${channelId}`;
  }
  function getMentionMode({ type, token, channelId }) {
    try {
      return bridgeStore.getSetting?.(mentionModeKey({ type, token, channelId })) === '1';
    } catch {
      return false;
    }
  }
  function setMentionMode({ type, token, channelId }, enabled) {
    try {
      bridgeStore.setSetting?.(mentionModeKey({ type, token, channelId }), enabled ? '1' : null);
    } catch {
      // best-effort
    }
  }

  /** Does this surface already have a session binding? (Mention mode skips bound threads.) */
  function hasSurfaceBinding({ type, token, channelId, threadId = null }) {
    try {
      const stored = bridgeStore.lookup({
        type,
        botTokenHash: tokenHash(token),
        targetKey: targetKey({ type, channelId, threadId }),
      });
      return Boolean(stored?.sessionId);
    } catch {
      return false;
    }
  }

  // --- Queue draining -------------------------------------------------------
  async function drainSurfaceQueue(ctx) {
    const key = queueKeyFor(ctx);
    const queue = surfaceQueues.get(key);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) surfaceQueues.delete(key);
    if (!next?.text) return;
    const who = next.from?.firstName || next.from?.username || 'queued';
    try {
      await postToSurface(ctx, `» **${escapeMd(who)}:** ${clipBlock(next.text, 500)}`);
    } catch {
      // cosmetic echo only
    }
    try {
      await routeInbound({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        text: next.text,
        projectPath: ctx.projectPath ?? null,
        from: next.from ?? null,
      });
    } catch (err) {
      console.warn('[BRIDGE] Failed to send queued message:', err?.message ?? err);
    }
  }

  // --- Pending-approval auto-reject -------------------------------------------
  // When a new message arrives for a session that still has unanswered
  // permission requests, reject them and strip the buttons so the session
  // unblocks and stale buttons can't be clicked later.
  async function rejectPendingApprovalsForSession(sessionId) {
    if (!sessionId) return 0;
    let rejected = 0;
    for (const [approvalId, ctx] of [...approvalContexts.entries()]) {
      if (approvalId === '_cleanup' || !ctx || ctx.sessionID !== sessionId) continue;
      approvalContexts.delete(approvalId);
      rejected += 1;

      // Strip the buttons from the Discord message (best-effort).
      const surface = ctx.surface;
      if (surface?.type === 'discord' && surface.token && surface.channelId && surface.messageId) {
        void fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(surface.channelId)}/messages/${encodeURIComponent(surface.messageId)}`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bot ${surface.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ components: [] }),
          },
        ).catch(() => {});
      }

      if (typeof _respondToOpenCode === 'function' && ctx.requestID) {
        try {
          await _respondToOpenCode({
            sessionID: ctx.sessionID,
            requestID: ctx.requestID,
            reply: 'reject',
            directory: ctx.directory || ctx.sdkDirectory,
          });
        } catch (err) {
          console.warn('[BRIDGE] Auto-reject failed:', err?.message ?? err);
        }
      }
    }
    if (rejected > 0) {
      console.log(`[BRIDGE] Auto-rejected ${rejected} stale permission request(s) for session ${sessionId}`);
    }
    return rejected;
  }

  // --- Question flow (the "ask" tool) ----------------------------------------
  // Questions block the agent until answered — like permissions, they are
  // first-class interactive events (question.asked on the SSE hub), rendered
  // with option buttons / select menus at EVERY verbosity level. Option
  // clicks come back through the Discord listener; a typed reply in the
  // thread answers the question as a custom answer (same as the web UI's
  // free-text answer field).

  /** POST the collected answers back to OpenCode's question.reply API. */
  async function replyQuestionToOpenCode({ requestID, answers, directory }) {
    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const r = await opencodeFetch(`/question/${encodeURIComponent(requestID)}/reply${dirParam}`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`OpenCode question reply ${r.status}: ${errText.slice(0, 200)}`);
    }
    return true;
  }

  /**
   * Post the question message(s) — one per question in the request — with
   * interactive option components, and register the question context so
   * interactions and typed replies can complete the request.
   */
  async function sendQuestionToSurface({ type, token, channelId, threadId, request, directory }) {
    if (type !== 'discord') return { ok: false, error: `Unsupported messenger type: ${type}` };
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (!request?.id || questions.length === 0) return { ok: false, error: 'empty question request' };

    const questionId = generateApprovalId();
    const ch = threadId ?? channelId;
    const messages = [];
    for (let qIdx = 0; qIdx < questions.length; qIdx += 1) {
      const content = renderQuestionForMessenger(questions[qIdx], { index: qIdx, total: questions.length });
      if (!content) continue;
      const components = buildQuestionComponents({ questionId, questionIndex: qIdx, question: questions[qIdx] });
      const r = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(ch)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content.slice(0, DISCORD_LIMIT),
            ...(components.length > 0 ? { components } : {}),
          }),
        },
      );
      if (!r.ok) {
        console.error('[BRIDGE] Failed to send question to Discord:', r.status, (await r.text()).slice(0, 200));
        continue;
      }
      const data = await r.json().catch(() => null);
      messages.push({ channelId: ch, messageId: data?.id ?? null, questionIndex: qIdx });
    }
    if (messages.length === 0) return { ok: false, error: 'question post failed' };

    questionContexts.set(questionId, {
      sessionID: request.sessionID ?? null,
      requestID: request.id,
      directory: directory ?? null,
      questions,
      answers: questions.map(() => null),
      surface: { type, token, messages },
      createdAt: Date.now(),
    });
    setTimeout(() => questionContexts.delete(questionId), QUESTION_CONTEXT_TTL_MS).unref();
    return { ok: true, questionId };
  }

  /** Strip the interactive components from a question's Discord messages. */
  function stripQuestionComponents(qctx) {
    const surface = qctx?.surface;
    if (surface?.type !== 'discord' || !surface.token) return;
    for (const msg of surface.messages ?? []) {
      if (!msg?.channelId || !msg?.messageId) continue;
      void editDiscordMessage({
        token: surface.token,
        channelId: msg.channelId,
        messageId: msg.messageId,
        components: [],
      }).catch(() => {});
    }
  }

  /**
   * Record an option pick for one question of a request. When every question
   * has an answer, the collected answers are sent to OpenCode. Returns
   * `{ ok, labels, complete }` for the listener to update the message, or
   * `{ ok: false, error }` when the context is unknown/expired.
   */
  function handleQuestionDecision(questionId, questionIndex, optionValues) {
    const qctx = questionContexts.get(questionId);
    if (!qctx) {
      console.log('[BRIDGE] No question context for', questionId, '(expired or already answered)');
      return { ok: false, error: 'expired' };
    }
    const index = Number(questionIndex);
    const question = qctx.questions[index];
    if (!question) return { ok: false, error: 'unknown question' };
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = (Array.isArray(optionValues) ? optionValues : [optionValues])
      .map((v) => options[Number(v)]?.label)
      .filter((label) => typeof label === 'string' && label.length > 0);
    if (labels.length === 0) return { ok: false, error: 'unknown option' };

    qctx.answers[index] = labels;
    const complete = qctx.answers.every((a) => Array.isArray(a) && a.length > 0);
    if (complete) {
      questionContexts.delete(questionId);
      console.log('[BRIDGE] Question answered:', { questionId, requestID: qctx.requestID, answers: qctx.answers });
      replyQuestionToOpenCode({
        requestID: qctx.requestID,
        answers: qctx.answers,
        directory: qctx.directory,
      }).catch((err) => {
        console.error('[BRIDGE] Failed to reply to question:', err?.message ?? err);
      });
    }
    return { ok: true, labels, complete };
  }

  /** First pending question context bound to a session, or null. */
  function findPendingQuestionForSession(sessionId) {
    if (!sessionId) return null;
    for (const [questionId, qctx] of questionContexts) {
      if (questionId === '_cleanup' || !qctx) continue;
      if (qctx.sessionID === sessionId) return [questionId, qctx];
    }
    return null;
  }

  /**
   * Treat a typed Discord reply as the (custom) answer to the session's
   * pending question — exactly what the web UI's free-text answer does.
   * Already-picked options on a multi-question request are kept; the text
   * fills every still-unanswered question. Returns true when the reply was
   * consumed as an answer (the caller must NOT also send it as a prompt).
   */
  async function answerPendingQuestionWithText(sessionId, text) {
    const found = findPendingQuestionForSession(sessionId);
    if (!found) return false;
    const [questionId, qctx] = found;
    const answers = qctx.questions.map((_, i) =>
      Array.isArray(qctx.answers[i]) && qctx.answers[i].length > 0 ? qctx.answers[i] : [text],
    );
    questionContexts.delete(questionId);
    stripQuestionComponents(qctx);
    try {
      await replyQuestionToOpenCode({
        requestID: qctx.requestID,
        answers,
        directory: qctx.directory,
      });
      return true;
    } catch (err) {
      // The request may have been answered/dismissed elsewhere — fall back
      // to sending the text as a normal prompt instead of swallowing it.
      console.warn('[BRIDGE] Typed question answer failed, sending as prompt:', err?.message ?? err);
      return false;
    }
  }

  // --- Todo/plan mirroring (todo.updated) -------------------------------------
  // The agent's task plan is session state the user should always see —
  // it is mirrored at EVERY verbosity level. One Discord message per turn
  // holds the current list; successive todo.updated events PATCH it in
  // place (debounced) instead of spamming the thread.
  /** @type {Map<string, { channelId: string|null, messageId: string|null, lastContent: string|null, timer: NodeJS.Timeout|null, pendingTodos: Array<object>|null }>} */
  const todoMessages = new Map();
  const TODO_DEBOUNCE_MS = 1_200;

  function scheduleTodoUpdate(ctx, sessionId, todos) {
    let entry = todoMessages.get(sessionId);
    if (!entry) {
      entry = { channelId: null, messageId: null, lastContent: null, timer: null, pendingTodos: null };
      todoMessages.set(sessionId, entry);
    }
    entry.pendingTodos = todos;
    if (entry.timer) return; // trailing-edge coalescing — latest todos win
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flushTodoUpdate(ctx, sessionId).catch(() => {});
    }, TODO_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  async function flushTodoUpdate(ctx, sessionId) {
    const entry = todoMessages.get(sessionId);
    if (!entry || !entry.pendingTodos) return;
    const todos = entry.pendingTodos;
    entry.pendingTodos = null;
    const content = renderTodoListForMessenger(todos);
    if (!content || content === entry.lastContent) return;
    if (ctx.type !== 'discord' || !ctx.token) return;
    const ch = ctx.threadId ?? ctx.channelId;

    if (entry.messageId && entry.channelId === ch) {
      const edited = await editDiscordMessage({
        token: ctx.token,
        channelId: ch,
        messageId: entry.messageId,
        content,
      });
      if (edited.ok) {
        entry.lastContent = content;
        return;
      }
      // The message may have been deleted — fall through and repost.
    }

    const sent = await sendDiscord({ token: ctx.token, channelId: ch, content });
    if (sent.ok) {
      entry.channelId = ch;
      entry.messageId = sent.id ?? null;
      entry.lastContent = content;
    }
  }

  /** Flush any pending todo render, then forget the message so the next turn posts fresh. */
  function finishTodoMessageForSession(ctx, sessionId) {
    const entry = todoMessages.get(sessionId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void (async () => {
      try {
        if (entry.pendingTodos && ctx) await flushTodoUpdate(ctx, sessionId);
      } catch {
        // best-effort
      }
      todoMessages.delete(sessionId);
    })();
  }

  // --- Last active Discord user --------------------------------------------------
  // Web-created mirror threads have no Discord message author to add as a
  // member, so without a configured owner they stay invisible in the channel
  // sidebar. Remember the last user who messaged the bot (per token) and use
  // them as the fallback owner for web threads.
  function rememberLastActiveDiscordUser(token, userId) {
    if (!token || !userId) return;
    try {
      bridgeStore.setSetting(`discord.lastActiveUserId.${tokenHash(token)}`, String(userId));
    } catch {
      // best-effort
    }
  }

  function getLastActiveDiscordUserId(token) {
    if (!token) return null;
    try {
      return bridgeStore.getSetting(`discord.lastActiveUserId.${tokenHash(token)}`) ?? null;
    } catch {
      return null;
    }
  }

  // --- Thread renaming from session titles -------------------------------------
  // OpenCode auto-generates a summary title for untitled sessions; we mirror
  // it onto the Discord thread. Discord rate-limits thread renames (~2 per
  // 10 minutes), so we rename at most once per distinct title and fail soft.
  /** @type {Map<string, string>} threadId → last applied OpenCode title */
  const appliedThreadTitles = new Map();
  const APPLIED_TITLE_CACHE_MAX = 500;

  async function maybeRenameThreadFromSessionTitle(sessionId, title) {
    try {
      const normalizedTitle = String(title ?? '').trim();
      if (!normalizedTitle) return;

      // Resolve the Discord surface for this session: live context first,
      // then the persistent binding lookup (covers server restarts).
      let surface = null;
      const ctx = sessionContexts.get(sessionId);
      if (ctx?.type === 'discord' && ctx.token && ctx.threadId) {
        surface = { token: ctx.token, threadId: ctx.threadId };
      } else if (typeof lookupMessengerTarget === 'function') {
        const target = await lookupMessengerTarget(sessionId);
        if (target?.type === 'discord' && target.token && target.targetKey) {
          surface = { token: target.token, threadId: target.targetKey };
        }
      }
      if (!surface) return;
      if (appliedThreadTitles.get(surface.threadId) === normalizedTitle) return;

      // Mark BEFORE any await so concurrent session.updated events for the
      // same title can't stack rename attempts — failures are almost always
      // rate limits, so retrying the same title wouldn't help anyway.
      if (appliedThreadTitles.size >= APPLIED_TITLE_CACHE_MAX) {
        const oldest = appliedThreadTitles.keys().next().value;
        if (oldest !== undefined) appliedThreadTitles.delete(oldest);
      }
      appliedThreadTitles.set(surface.threadId, normalizedTitle);

      // Fetch the channel to confirm it IS a thread (never rename a text
      // channel) and to read the current name for prefix preservation.
      const chRes = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(surface.threadId)}`,
        { headers: { Authorization: `Bot ${surface.token}` }, signal: AbortSignal.timeout(3000) },
      );
      if (!chRes.ok) return;
      const channel = await chRes.json();
      if (![10, 11, 12].includes(channel?.type)) return;

      const desiredName = deriveThreadNameFromSessionTitle({
        sessionTitle: normalizedTitle,
        currentName: channel?.name ?? '',
      });
      if (!desiredName) return;

      const res = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(surface.threadId)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bot ${surface.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: desiredName }),
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!res.ok) {
        console.warn(`[BRIDGE] Could not rename thread ${surface.threadId} from session title: Discord ${res.status}`);
        return;
      }
      console.log(`[BRIDGE] Renamed thread ${surface.threadId} → "${desiredName}" (session ${sessionId})`);
    } catch (err) {
      console.warn('[BRIDGE] Thread rename failed:', err?.message ?? err);
    }
  }

  // Polling fallback for thread renames. The event-driven rename above can
  // miss titles: OpenCode may generate the title BEFORE the mirror thread
  // exists (web sessions create their thread lazily on first assistant
  // output), the server may restart between the event and the rename, or the
  // SSE stream may briefly drop. The reference bridge solves this with a
  // periodic session sweep — we do the same: every sweep, fetch the session
  // title for live Discord contexts and recently-used bindings and apply any
  // title we haven't applied yet (the dedupe cache makes re-checks free).
  const TITLE_SWEEP_INTERVAL_MS = 10_000;
  const TITLE_SWEEP_MAX_SESSIONS = 25;
  const TITLE_SWEEP_BINDING_WINDOW_MS = 6 * 60 * 60 * 1000; // recent = last 6h

  async function sweepThreadTitles() {
    /** @type {Map<string, string|null>} sessionId → projectPath */
    const candidates = new Map();
    for (const [sessionId, ctx] of sessionContexts) {
      if (ctx?.type === 'discord' && ctx.threadId) {
        candidates.set(sessionId, ctx.projectPath ?? null);
      }
    }
    try {
      const cutoff = Date.now() - TITLE_SWEEP_BINDING_WINDOW_MS;
      for (const b of bridgeStore.list({ type: 'discord' })) {
        if (!b.sessionId || candidates.has(b.sessionId)) continue;
        const lastUsed = Number(b.lastUsedAt ?? b.updatedAt ?? 0);
        if (lastUsed && lastUsed < cutoff) continue;
        candidates.set(b.sessionId, b.projectPath ?? null);
      }
    } catch {
      // store unavailable — live contexts still get swept
    }

    let checked = 0;
    for (const [sessionId, projectPath] of candidates) {
      if (checked >= TITLE_SWEEP_MAX_SESSIONS) break;
      checked += 1;
      try {
        const dir = projectPath ? `?directory=${encodeURIComponent(projectPath)}` : '';
        const res = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}${dir}`);
        if (!res.ok) continue;
        const session = await res.json().catch(() => null);
        if (session?.title) {
          await maybeRenameThreadFromSessionTitle(sessionId, session.title);
        }
      } catch {
        // best-effort per session
      }
    }
  }

  let titleSweepTimer = null;
  function startTitleSweep() {
    if (titleSweepTimer) return;
    titleSweepTimer = setInterval(() => void sweepThreadTitles().catch(() => {}), TITLE_SWEEP_INTERVAL_MS);
    titleSweepTimer.unref?.();
  }
  startTitleSweep();

  // --- Scheduled prompts -------------------------------------------------------
  // The Discord `/schedule` command writes into OpenChamber's EXISTING
  // per-project scheduler (the same one the web UI's Scheduled-tasks dialog
  // manages), so tasks created from Discord, the UI or the agent all live in
  // one place and stay in sync. Task runs create fresh OpenCode sessions; the
  // web-session mirroring streams their output into Discord automatically.

  /** Map a project path to its OpenChamber project id (for the scheduler API). */
  async function resolveProjectIdForPath(projectPath) {
    if (!projectPath || typeof listProjects !== 'function') return null;
    try {
      const projects = await listProjects();
      const match = (projects ?? []).find((p) => p?.path === projectPath);
      return match?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Parse the `/schedule <when>` token into the project scheduler's schedule
   * shape. Accepts:
   *   - 5-field cron (UTC):       `0 9 * * 1`
   *   - one-time UTC ISO minute:  `2026-03-01T09:00` (trailing `Z`/seconds ok)
   * Returns { schedule } or { error }.
   */
  function parseScheduleWhen(when) {
    const raw = String(when ?? '').trim();
    if (!raw) return { error: 'schedule time is required.' };

    const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?Z?$/);
    if (isoMatch) {
      const [, date, time] = isoMatch;
      const runAt = Date.parse(`${date}T${time}:00Z`);
      if (!Number.isFinite(runAt)) return { error: `invalid date: ${raw}` };
      if (runAt <= Date.now()) return { error: `the date must be in the future (UTC): ${raw}` };
      return { schedule: { kind: 'once', date, time, timezone: 'UTC' } };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return { error: `dates must be UTC ISO format like 2026-03-01T09:00 (got: ${raw})` };
    }

    try {
      parser.parseExpression(raw, { utc: true });
    } catch {
      return { error: `invalid cron expression: ${raw}` };
    }
    return { schedule: { kind: 'cron', cron: raw, timezone: 'UTC' } };
  }

  /** Compact human description of a project scheduled task for Discord. */
  function describeSchedule(task) {
    const s = task?.schedule ?? {};
    const tz = s.timezone ? ` (${s.timezone})` : '';
    if (s.kind === 'once') return `once at ${s.date} ${s.time}${tz}`;
    if (s.kind === 'cron') return `cron \`${s.cron}\`${tz}`;
    if (s.kind === 'daily') return `daily at ${(s.times ?? [s.time]).filter(Boolean).join(', ')}${tz}`;
    if (s.kind === 'weekly') return `weekly (${(s.weekdays ?? []).join(',')}) at ${(s.times ?? [s.time]).filter(Boolean).join(', ')}${tz}`;
    return 'unknown schedule';
  }

  /**
   * Compact scheduling instructions injected into each new session so the
   * agent can set up reminders / recurring runs on request. Points at the
   * SAME per-project scheduler API the web UI uses.
   */
  async function buildSchedulingInstructions({ projectPath }) {
    const base = typeof getLocalApiBaseUrl === 'function' ? getLocalApiBaseUrl() : null;
    if (!base || !projectConfigRuntime) return null;
    const projectId = await resolveProjectIdForPath(projectPath);
    if (!projectId) return null;
    const api = `${base}/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`;
    return [
      '<scheduling>',
      'You can schedule prompts (reminders, recurring jobs) in this project\'s task scheduler via the local OpenChamber API using bash curl. Scheduled tasks are visible and editable in the web UI.',
      'Create / update (PUT). schedule.kind: "cron" (5-field, with timezone), "once" (date+time), "daily"/"weekly" (times). execution.providerID/modelID are REQUIRED — reuse the current session model unless the user asks otherwise:',
      `  curl -s -X PUT ${api} -H 'Content-Type: application/json' -d '{"task":{"name":"<short name>","schedule":{"kind":"cron","cron":"0 9 * * 1","timezone":"UTC"},"execution":{"prompt":"<detailed prompt>","providerID":"<provider>","modelID":"<model>"}}}'`,
      `One-time example: {"schedule":{"kind":"once","date":"2026-03-01","time":"09:00","timezone":"UTC"}}`,
      `Manage: curl -s ${api}   (list) · curl -s -X DELETE ${api}/<taskId>   (remove)`,
      'Use detailed prompts: goal, constraints, expected output, completion criteria. Never guess the user timezone — ask, or use UTC.',
      'Always tell the user when you scheduled something (include the task id and when it runs next).',
      '</scheduling>',
    ].join('\n');
  }

  /**
   * Compact Discord instructions injected into each new session when a Discord
   * bot is configured. Points the agent at the agent-facing Discord API so it
   * can post status updates / results into any project channel or session
   * thread (including a different project's thread) without handling the token.
   */
  async function buildDiscordInstructions() {
    const base = typeof getLocalApiBaseUrl === 'function' ? getLocalApiBaseUrl() : null;
    if (!base || !readSettings) return null;
    let settings;
    try {
      settings = await readSettings();
    } catch {
      return null;
    }
    if (!settings?.discord?.botToken) return null;
    const api = `${base}/api/otto/messenger/agent`;
    return [
      '<discord>',
      'This OpenChamber server is connected to Discord. You can post messages to Discord channels and threads via the local API using bash curl — the bot token is resolved server-side, so never ask for or pass it. Useful for status updates, sharing results, or pinging another project/thread.',
      `List targets (projects ↔ channels and live sessions ↔ threads, each with a Discord URL): curl -s ${api}/targets`,
      `Post: curl -s -X POST ${api}/post -H 'Content-Type: application/json' -d '{"project":"<name|path>","text":"<message>"}'`,
      `  Address by session instead: {"session":"<sessionID>","text":"…"} · or a raw channel/thread id or discord.com/channels URL: {"channel":"<id|url>","text":"…"}`,
      `Resolve a Discord URL without posting: curl -s -X POST ${api}/resolve -H 'Content-Type: application/json' -d '{"project":"<name>"}'`,
      'Markdown works; messages over 2000 chars are split automatically; add "silent":true to avoid pinging. Tell the user where you posted (include the returned url).',
      '</discord>',
    ].join('\n');
  }

  /** Resolve a thread's parent channel id via the Discord API (for /resume, /fork etc. run inside threads). */
  async function resolveParentChannelId({ token, channelId }) {
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!r.ok) return null;
      const data = await r.json();
      // Thread types: 10/11/12. For threads, parent_id is the host channel.
      if ([10, 11, 12].includes(data?.type) && data?.parent_id) return String(data.parent_id);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the effective verbosity for a surface at render time.
   * Resolution order: surface override (`/verbosity X`) → parent-channel
   * override (for thread follow-ups) → per-project default → per-messenger UI
   * default → `normal`.
   */
  function resolveVerbosity({ type, token, channelId, threadId }) {
    const hash = tokenHash(token);
    const stableKey = targetKey({ type, channelId, threadId });
    let level = null;
    try {
      const row = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
      let projectPath = row?.projectPath ?? null;
      level = row?.verbosityOverride ?? null;
      if (!level && stableKey !== String(channelId)) {
        const parent = bridgeStore.lookup({
          type,
          botTokenHash: hash,
          targetKey: String(channelId),
        });
        level = parent?.verbosityOverride ?? null;
        if (!projectPath) projectPath = parent?.projectPath ?? null;
      }
      // Per-project default — the layer the user can set once and have apply to
      // every Discord surface that lands in this project.
      if (!level && projectPath) {
        level = bridgeStore.getProjectDefaults?.(projectPath)?.verbosityDefault ?? null;
      }
      if (!level) level = bridgeStore.getVerbosityDefault?.(type) ?? null;
    } catch {
      // ignore — verbosity is best-effort, fall back to the default
    }
    return normalizeVerbosity(level ?? DEFAULT_VERBOSITY);
  }

  /**
   * Resolve the effective permission mode for a surface (`ask` | `auto-edit` |
   * `yolo`). Mirrors {@link resolveVerbosity}'s resolution order: surface
   * override (`/yolo`) → parent-channel override → per-project default →
   * per-messenger default → `ask`. Read fresh at each `permission.asked` event
   * so a `/yolo` change applies without a restart.
   */
  function resolvePermissionMode({ type, token, channelId, threadId }) {
    const hash = tokenHash(token);
    const stableKey = targetKey({ type, channelId, threadId });
    let mode = null;
    try {
      const row = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
      let projectPath = row?.projectPath ?? null;
      mode = row?.permissionModeOverride ?? null;
      if (!mode && stableKey !== String(channelId)) {
        const parent = bridgeStore.lookup({
          type,
          botTokenHash: hash,
          targetKey: String(channelId),
        });
        mode = parent?.permissionModeOverride ?? null;
        if (!projectPath) projectPath = parent?.projectPath ?? null;
      }
      if (!mode && projectPath) {
        mode = bridgeStore.getProjectDefaults?.(projectPath)?.permissionModeDefault ?? null;
      }
      if (!mode) mode = bridgeStore.getPermissionModeDefault?.(type) ?? null;
    } catch {
      // ignore — best-effort, fall back to the safe default (ask)
    }
    return normalizePermissionMode(mode ?? DEFAULT_PERMISSION_MODE);
  }

  // --- Outbound: post one message per renderable part --------------------
  async function postToSurface(ctx, content) {
    return postMessengerSurface(ctx, content);
  }

  /** Like postToSurface but takes a raw surface descriptor — used by the
   *  bootstrap dialogue before a session exists. Long content is split into
   *  multiple messages on line boundaries instead of being truncated at
   *  Discord's 2000-char limit (long /help output etc.). */
  async function postMessengerSurface({ type, token, channelId, threadId }, content) {
    if (!content) return { ok: false, error: 'empty content' };
    if (type === 'discord') {
      const ch = threadId ?? channelId;
      const chunks = splitForDiscord(content);
      let last = { ok: false, error: 'empty content' };
      for (const chunk of chunks) {
        last = await sendDiscord({ token, channelId: ch, content: chunk });
        if (!last.ok) break;
      }
      return last;
    }
    return { ok: false, error: `Unsupported messenger type: ${type}` };
  }

  /** Split a message into ≤ DISCORD_LIMIT chunks, preferring newline breaks. */
  function splitForDiscord(content, maxChunks = 4) {
    const text = String(content);
    if (text.length <= DISCORD_LIMIT) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > 0 && chunks.length < maxChunks - 1) {
      if (rest.length <= DISCORD_LIMIT) break;
      let cut = rest.lastIndexOf('\n', DISCORD_LIMIT - 1);
      if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT - 1;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest.length > 0) chunks.push(rest.slice(0, DISCORD_LIMIT));
    return chunks;
  }

  function startTypingPulse(ctx) {
    if (ctx.typingTimer) return;
    ctx.typingStopped = false;
    const pulse = async () => {
      if (ctx.typingStopped) return;
      if (!sessionContexts.has(ctx.sessionId)) return;
      if (ctx.type === 'discord') {
        await discordTyping({ token: ctx.token, channelId: ctx.threadId ?? ctx.channelId });
      }
      // Re-check after the await: stopTypingPulse may have run while the
      // typing request was in flight (when typingTimer was still unset),
      // which would otherwise let a stale pulse re-arm the timer forever.
      if (ctx.typingStopped) return;
      ctx.typingTimer = setTimeout(pulse, TYPING_PULSE_DISCORD_MS);
    };
    // First pulse immediately so the user sees the indicator right away.
    void pulse();
  }

  function stopTypingPulse(ctx) {
    ctx.typingStopped = true;
    if (ctx.typingTimer) {
      clearTimeout(ctx.typingTimer);
      ctx.typingTimer = undefined;
    }
  }

  async function ensureDefaultSessionContext(sessionId, { projectPath = null, threadName = null } = {}) {
    if (!sessionId) return null;
    const existing = sessionContexts.get(sessionId);
    if (existing) return existing;
    if (typeof getDefaultMessengerTarget !== 'function') return null;

    // Coalesce concurrent creations for the same session so the user part and
    // the first assistant part don't each spawn their own Discord thread.
    const inflight = pendingContextCreations.get(sessionId);
    if (inflight) return inflight;

    const creation = (async () => {
      let target = null;
      try {
        target = await getDefaultMessengerTarget({ sessionId, projectPath });
      } catch {
        return null;
      }
      if (!target?.type || !target?.token || !target?.channelId) return null;

      const type = target.type;
      const token = target.token;
      const channelId = String(target.channelId);
      const effectiveProjectPath = target.projectPath ?? projectPath ?? null;
      let threadId = target.threadId ? String(target.threadId) : null;

      // For Discord, give each web conversation its own thread inside the
      // project channel. Reuse a thread already bound to this session (so a
      // continued conversation keeps the same thread), otherwise create one.
      if (type === 'discord' && !threadId) {
        const hash = tokenHash(token);
        try {
          const bound = bridgeStore
            .lookupBySessionId(sessionId)
            .find((b) => b.type === 'discord' && b.targetKey);
          if (bound?.targetKey) threadId = String(bound.targetKey);
        } catch {
          // best-effort — fall through to creating a fresh thread
        }
        if (!threadId) {
          // Thread name preference: the OpenCode-generated session title (when
          // it already exists — title generation often finishes before the
          // mirror thread is created), then the user's first line, then a
          // generic project label. The polling title sweep upgrades the name
          // later if the title lands after creation.
          let name = threadName || target.threadName || `OpenChamber agent · ${target.projectLabel ?? 'web'}`;
          try {
            const dir = effectiveProjectPath ? `?directory=${encodeURIComponent(effectiveProjectPath)}` : '';
            const sRes = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}${dir}`);
            if (sRes.ok) {
              const s = await sRes.json().catch(() => null);
              const t = String(s?.title ?? '').trim();
              if (t && !/^new session\s*-/i.test(t)) name = t;
            }
          } catch {
            // best-effort — keep the fallback name
          }
          const created = await startStandaloneDiscordThread({
            token,
            channelId,
            name,
            // Add the configured Discord owner(s) so the thread is visible to
            // them under the channel right away (issue: UI-created threads were
            // invisible because the bot was the only member). When no owner is
            // configured, fall back to the last Discord user who talked to the
            // bot — the reference bridge always has a message author to anchor
            // membership on; this is our web-session equivalent.
            userIds:
              target.userIds ??
              target.userId ??
              getLastActiveDiscordUserId(token),
          });
          if (created.ok && created.threadId) {
            threadId = created.threadId;
            try {
              bridgeStore.bind({
                type: 'discord',
                botTokenHash: hash,
                targetKey: threadId,
                sessionId,
                projectPath: effectiveProjectPath,
                projectLabel: target.projectLabel ?? null,
              });
            } catch {
              // binding is an optimization (continue-existing across restarts)
            }
          }
          // If thread creation failed, threadId stays null and we post into
          // the channel directly — degraded but functional.
        }
      }

      const ctx = {
        sessionId,
        type,
        token,
        channelId,
        threadId: threadId ? String(threadId) : null,
        projectPath: effectiveProjectPath,
        sentPartIds: new Set(),
        startedAt: Date.now(),
        lastError: null,
        verbosity: DEFAULT_VERBOSITY,
        from: null,
        webMirror: true,
        source: 'web',
      };
      ctx.verbosity = resolveVerbosity({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
      });
      sessionContexts.set(sessionId, ctx);
      broadcastEvent?.('messenger.bridge.web_session_bound', {
        type: ctx.type,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        sessionId,
        projectPath: ctx.projectPath,
      });
      return ctx;
    })();

    pendingContextCreations.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      pendingContextCreations.delete(sessionId);
    }
  }

  async function emitWebUserPart(sessionId, part, { projectPath = null } = {}) {
    const text = typeof part?.text === 'string' ? part.text.trim() : '';
    // Never mirror the synthetic shell marker as a **Web** prompt block — it is
    // internal noise ("The following tool was executed by the user"). The
    // command + output are mirrored separately as a shell block (emitPart).
    if (isUserShellMarkerText(text)) return;
    // Never mirror a prompt that originated from a messenger surface back to the
    // same surface. This stops the "I reply from Discord and my own message
    // bounces straight back to me" duplication on web-created threads that are
    // later continued from Discord.
    if (consumeMessengerInbound(sessionId, text)) return;
    // Name the thread (when one is created) after the user's first line so the
    // Discord thread list is meaningful instead of a wall of "OpenChamber agent · web".
    const threadName = text ? clipBlock(text.split('\n')[0], 80) : null;
    const ctx = await ensureDefaultSessionContext(sessionId, { projectPath, threadName });
    if (!ctx?.webMirror) return;
    if (!text) return;
    const dedupKey = part?.id ? `${part.id}:user` : null;
    if (dedupKey && ctx.sentPartIds.has(dedupKey)) return;
    const safe = clipBlock(text.replace(/```/g, "'''"), 1500);
    const sent = await postToSurface(ctx, `**Web**\n\`\`\`\n${safe}\n\`\`\``);
    if (!sent.ok) {
      ctx.lastError = sent.error;
      return;
    }
    if (dedupKey) ctx.sentPartIds.add(dedupKey);
  }

  async function emitPart(sessionId, part) {
    const ctx = sessionContexts.get(sessionId);
    if (!ctx) return;
    // A new turn is producing output — clear any prior error state so its
    // session.idle posts a proper "done" footer again, and re-arm idle
    // settling so this turn's session.idle is processed (not deduped).
    ctx.errored = false;
    ctx.idleSettled = false;
    const partId = part?.id;
    const partType = part?.type;
    // Re-resolve per part (cheap SQLite lookup) so `/verbosity` changes and
    // UI default changes apply mid-turn — long-lived web-mirror contexts used
    // to cache the level at creation and never pick up changes.
    ctx.verbosity = resolveVerbosity({
      type: ctx.type,
      token: ctx.token,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
    });
    const verbosity = normalizeVerbosity(ctx.verbosity);

    // Skip duplicates we've already posted (parts get many updates as they
    // stream — we only want one Discord message per logical part).
    // Tools transition pending → running → completed/error; we want the
    // running/error/completed event with a stable state, not every delta.
    if (partType === 'text') {
      if (!part?.time?.end) return; // wait until streaming finishes
    }
    // A user-run shell command (`/shell` or web `!cmd`) surfaces as an
    // assistant bash echo whose parent is the synthetic shell-marker message.
    // Its command + output are always shown — the user explicitly asked to run
    // it, so unlike agent tool activity it is not gated by verbosity.
    const shellEcho = partType === 'tool' ? getUserShellEcho(part) : null;
    if (partType === 'tool') {
      const status = part.state?.status ?? 'running';
      // One message per tool, at the terminal state. Posting a separate
      // "running" line and then a "completed" line doubled every tool into
      // two messages and made the feed unreadable. Waiting for the terminal
      // state also lets the one-liner include result metadata (match counts,
      // error text) and, at `verbose`, the real input + output blocks.
      if (status !== 'completed' && status !== 'error') return;
      // `quiet` suppresses agent tool activity entirely — but never a shell
      // command the user themselves invoked.
      if (!shellEcho && verbosity === 'quiet') return;
    }
    if (partType === 'reasoning') {
      if (verbosity === 'quiet') return;
      // Wait until the reasoning text is non-empty before posting.
      // The first update often arrives with empty text while the model
      // is still generating — posting then creates an empty code block.
      if (!part?.text || !String(part.text).trim()) return;
    }

    const dedupKey = partId ? `${partId}:${partType}:${part?.state?.status ?? ''}` : null;
    if (dedupKey && ctx.sentPartIds.has(dedupKey)) return;

    const rendered = shellEcho
      ? renderUserShellResult(shellEcho)
      : renderPartForMessenger(part, verbosity);
    if (!rendered) return;

    // At `normal`, reasoning renders as a bare process marker. Consecutive
    // reasoning parts would repeat it — post the marker only once until a
    // different kind of content interleaves.
    if (rendered === THINKING_MARKER) {
      if (ctx.lastPostedMarker === THINKING_MARKER) {
        if (dedupKey) ctx.sentPartIds.add(dedupKey);
        return;
      }
      ctx.lastPostedMarker = THINKING_MARKER;
    } else {
      ctx.lastPostedMarker = null;
    }

    const sent = await postToSurface(ctx, rendered);
    if (!sent.ok) {
      ctx.lastError = sent.error;
      return;
    }
    if (dedupKey) ctx.sentPartIds.add(dedupKey);
  }

  async function handleGlobalEvent(normalized) {
    const payload = normalized.payload ?? normalized;
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type ?? payload.event ?? null;
    const props = payload.properties ?? payload.props ?? payload;
    // The SSE envelope carries the authoritative directory the event belongs
    // to. This is the directory OpenCode expects when we reply to a permission
    // request — more reliable than guessing from the session's project path.
    const envelopeDirectory =
      typeof normalized?.directory === 'string' &&
      normalized.directory.length > 0 &&
      normalized.directory !== 'global'
        ? normalized.directory
        : null;

    if (type === 'message.part.updated') {
      const part = props?.part;
      const sessionId = getPartSessionId(part, props);
      if (!sessionId) return;
      const role = resolvePartRole(part, props);
      const partMessageId = getPartMessageId(part);
      if (!role) {
        if (partMessageId) rememberPendingPart(part, envelopeDirectory);
        return;
      }
      if (role === 'user') {
        // Remember the synthetic shell-marker message so the assistant echo of
        // a user-run shell command (`/shell` / web `!cmd`) can be recognised
        // and rendered as a clean command + output block. Done for every
        // surface (Discord-bound too), before the web-mirror gate below skips
        // non-web sessions.
        if (part?.type === 'text' && isUserShellMarkerText(part.text) && partMessageId) {
          rememberShellMarkerMessage(partMessageId);
        }
        // Mirror the user's own prompt into the messenger as a **Web** block.
        // Only for web-originated sessions: a session already bound to a
        // Discord surface had its prompt typed there already, so
        // echoing it back would duplicate it.
        const ctx = sessionContexts.get(sessionId);
        if (!ctx) {
          // Check the bridge store: if this session has a Discord
          // binding, the user's prompt came from a messenger, not the web.
          // This handles edge cases where the in-memory context was lost
          // (e.g. server restart while a session was actively streaming).
          const messengerBindings = bridgeStore
            .lookupBySessionId(sessionId)
            .filter((b) => b.type === 'discord');
          if (messengerBindings.length === 0) {
            await emitWebUserPart(sessionId, part, { projectPath: envelopeDirectory });
          }
        } else if (ctx.source === 'web' || ctx.webMirror) {
          await emitWebUserPart(sessionId, part, { projectPath: envelopeDirectory });
        }
        return;
      }
      if (!sessionContexts.has(sessionId)) {
        const ctx = await ensureDefaultSessionContext(sessionId, { projectPath: envelopeDirectory });
        if (ctx) await emitPart(sessionId, part);
        return;
      }
      await emitPart(sessionId, part);
      return;
    }
    if (type === 'message.updated') {
      // Cache the message role so the part handler (whose events don't carry a
      // role) can tell user prompts apart from assistant output. If the part
      // arrived first, replay it now that the role is known.
      const info = props?.info ?? props?.message ?? null;
      const messageId = getMessageId(info);
      const role = info?.role ?? info?.message?.role ?? props?.role ?? props?.message?.role ?? null;
      // Record parentID so a user-run shell command's assistant echo can be
      // linked back to its synthetic shell-marker parent (see getUserShellEcho).
      const parentId = info?.parentID ?? info?.message?.parentID ?? null;
      if (messageId && parentId) rememberMessageParent(messageId, parentId);
      if (messageId && role) {
        rememberMessageRole(messageId, role);
        const pending = pendingPartsByMessageId.get(messageId);
        if (pending) {
          pendingPartsByMessageId.delete(messageId);
          await handleGlobalEvent({
            ...normalized,
            directory: pending.projectPath ?? envelopeDirectory ?? normalized?.directory,
            payload: {
              type: 'message.part.updated',
              properties: { part: pending.part },
            },
          });
        }
      }
      return;
    }
    if (type === 'session.updated') {
      const info = props?.info ?? props ?? null;
      const sessionId = info?.id ?? props?.sessionID ?? props?.sessionId ?? null;
      if (sessionId && typeof info?.title === 'string') {
        void maybeRenameThreadFromSessionTitle(sessionId, info.title);
      }
      return;
    }
    if (type === 'session.deleted' || type === 'session.removed') {
      const sessionId =
        props?.sessionID ?? props?.sessionId ?? props?.info?.id ?? props?.id ?? null;
      if (sessionId) void handleSessionDeleted(sessionId);
      return;
    }
    if (type === 'session.idle') {
      const sessionId = props?.sessionID ?? props?.sessionId ?? null;
      // A plain message superseded this turn — the abort just settled. Skip the
      // "done" footer / queue drain and fire the stashed new message instead.
      if (sessionId && pendingSupersede.has(sessionId)) {
        runSupersede(sessionId, sessionContexts.get(sessionId));
        return;
      }
      const ctx = sessionId ? sessionContexts.get(sessionId) : null;
      if (!ctx) {
        const defaultCtx = await ensureDefaultSessionContext(sessionId, { projectPath: envelopeDirectory });
        if (defaultCtx) await handleGlobalEvent(normalized);
        return;
      }
      // Dedupe duplicate session.idle events. OpenCode emits session.idle more
      // than once after a turn settles — notably on abort / force-stop (UI Stop
      // button or `/abort`), which is what produced two "done · …" footers
      // (the second showing a bogus sub-second duration because startedAt was
      // reset for the next turn below). Only the first idle settles a turn; the
      // flag resets when the next turn produces output (emitPart) or a new
      // prompt is sent, so a genuine follow-up turn still gets its own footer.
      if (ctx.idleSettled) {
        stopTypingPulse(ctx);
        return;
      }
      ctx.idleSettled = true;
      // The turn already surfaced an error — OpenCode still emits idle (often
      // more than once) afterwards. Skip the misleading "done · 1ms" footer but
      // still settle the turn (clear busy, flush todos, drain the queue). The
      // errored flag stays set until the next turn produces output.
      if (ctx.errored) {
        stopTypingPulse(ctx);
        finishTodoMessageForSession(ctx, sessionId);
        ctx.sentPartIds.clear();
        ctx.startedAt = Date.now();
        busySessions.delete(sessionId);
        void drainSurfaceQueue(ctx);
        return;
      }
      stopTypingPulse(ctx);
      const ms = Date.now() - ctx.startedAt;
      const duration = ms < 1000 ? ms + 'ms' : Math.round(ms / 100) / 10 + 's';

      // Fetch model + token + context limit from OpenCode API.
      void (async () => {
        let footer = `_done · ${duration}`;
        try {
          const dir = ctx.projectPath ? `?directory=${encodeURIComponent(ctx.projectPath)}` : '';
          const [sessionRes, messagesRes, providersRes] = await Promise.all([
            opencodeFetch(`/session/${encodeURIComponent(sessionId)}${dir}`),
            opencodeFetch(`/session/${encodeURIComponent(sessionId)}/message${dir}`),
            opencodeFetch(`/provider`),
          ]);
          if (sessionRes.ok) {
            const d = await sessionRes.json().catch(() => null);
            const modelInfo = d?.model;

            // Add model name
            if (modelInfo) {
              const modelId = modelInfo.id ?? '';
              const providerId = modelInfo.providerID ?? '';
              const modelStr = providerId ? `${providerId}/${modelId}` : modelId;
              if (modelStr) footer += ` ⋅ \`${modelStr}\``;
            }

            // Context usage = the LAST assistant turn's tokens, the same way
            // the web UI computes it. The session object's `tokens` field is
            // a cumulative sum over every turn (cache reads re-counted each
            // time), which inflated the footer severalfold on long sessions.
            let lastTurnTokens = null;
            if (messagesRes.ok) {
              const messages = await messagesRes.json().catch(() => null);
              lastTurnTokens = extractLastAssistantTokens(messages);
            }
            const total = computeTurnTokens(lastTurnTokens);

            if (total > 0) {
              // Look up context limit from provider data
              let contextLimit = null;
              if (providersRes.ok) {
                try {
                  const pd = await providersRes.json();
                  const allProviders = Array.isArray(pd?.all) ? pd.all : Array.isArray(pd?.data) ? pd.data : [];
                  const targetProvider = allProviders.find((p) => p.id === modelInfo?.providerID);
                  if (targetProvider?.models) {
                    const models = Array.isArray(targetProvider.models)
                      ? targetProvider.models
                      : Object.values(targetProvider.models);
                    const targetModel = models.find((m) => (m.id ?? m.name) === modelInfo?.id);
                    if (targetModel?.limit?.context) {
                      contextLimit = targetModel.limit.context;
                    }
                  }
                } catch {}
              }

              footer += ` ⋅ ${total.toLocaleString()} tokens`;
              if (contextLimit && contextLimit > 0) {
                const pct = Math.round((total / contextLimit) * 100);
                footer += ` (${pct}% of context)`;
              }
            }
          }
        } catch {
          // Best-effort — fall back to duration-only footer.
        }
        footer += '_';
        void postToSurface(ctx, footer);
      })();

      // Flush the turn's final todo state and detach the live checklist
      // message — the next turn posts a fresh one near its own activity.
      finishTodoMessageForSession(ctx, sessionId);

      // Keep ctx around — follow-up messages in the same thread will reuse
      // the session id; but reset sentPartIds and startedAt for the next turn.
      ctx.sentPartIds.clear();
      ctx.startedAt = Date.now();
      busySessions.delete(sessionId);
      broadcastEvent?.('messenger.bridge.session_idle', {
        type: ctx.type,
        sessionId,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
      });
      // Drain one queued message for this surface: /queue'd
      // follow-ups send automatically after each response completes.
      void drainSurfaceQueue(ctx);
      return;
    }
    if (type === 'session.error') {
      const sessionId = props?.sessionID ?? props?.sessionId ?? null;
      // A plain message superseded this turn — the abort settled as an error.
      // Fire the stashed new message instead of surfacing the abort as a fault.
      if (sessionId && pendingSupersede.has(sessionId)) {
        runSupersede(sessionId, sessionContexts.get(sessionId));
        return;
      }
      if (sessionId) busySessions.delete(sessionId);
      const ctx = sessionId ? sessionContexts.get(sessionId) : null;
      if (!ctx) {
        const defaultCtx = await ensureDefaultSessionContext(sessionId, { projectPath: envelopeDirectory });
        if (defaultCtx) await handleGlobalEvent(normalized);
        return;
      }
      const errText = formatSessionError(props?.error);
      const now = Date.now();
      // A turn superseded moments ago can emit a trailing abort error for the
      // cancelled work while the replacement turn is already streaming. Don't
      // surface that teardown as a fault, and keep the typing pulse (the new
      // turn owns the surface now).
      if (
        ctx.supersededAt &&
        now - ctx.supersededAt < SUPERSEDE_ERROR_GRACE_MS &&
        isTransientTurnError(errText)
      ) {
        ctx.sentPartIds.clear();
        return;
      }
      stopTypingPulse(ctx);
      // Mark the turn as errored so the trailing session.idle doesn't tack on a
      // misleading "done · …" footer. The flag clears when the next turn starts
      // producing output (see emitPart) or a new prompt is sent.
      ctx.errored = true;
      // OpenCode emits one session.error per failed write (message + each part),
      // so the same fault can arrive several times in a row. Collapse repeats so
      // the surface isn't spammed with three identical lines.
      if (ctx.lastErrorText === errText && now - (ctx.lastErrorAt ?? 0) < 30000) {
        ctx.sentPartIds.clear();
        return;
      }
      ctx.lastErrorText = errText;
      ctx.lastErrorAt = now;
      ctx.lastError = errText;
      void postToSurface(ctx, `✗ ${escapeMd(clipBlock(errText, 280))}`);
      ctx.sentPartIds.clear();
      return;
    }

    // ── Permission requested — send Approve/Deny buttons ───────────
    if (type === 'permission.asked') {
      const sessionId = props?.sessionID ?? props?.sessionId ?? null;
      let ctx = sessionId ? sessionContexts.get(sessionId) : null;

      // If the session is not tracked locally (e.g. gateway bot handles inbound),
      // try to look up the binding from the bridge store and messenger config.
      if (!ctx && sessionId && lookupMessengerTarget) {
        try {
          const binding = await lookupMessengerTarget(sessionId);
          if (binding) {
            // Build a temporary context so we can forward the permission
            ctx = {
              type: binding.type,
              token: binding.token,
              channelId: binding.targetKey,
              threadId: binding.threadId ?? null,
              projectPath: binding.projectPath ?? null,
            };
          }
        } catch {
          // lookup failed — fall through to the return below
        }
      }

      if (!ctx) {
        ctx = await ensureDefaultSessionContext(sessionId, { projectPath: envelopeDirectory });
      }

      if (!ctx) {
        // No surface to post to — log and skip
        console.log('[PERMISSION]', `No surface for session=${sessionId} — cannot forward to messenger`);
        return;
      }

      // Permission requests are interactive UI — stop typing indicator
      if (stopTypingPulse) stopTypingPulse(ctx);

      const permission = {
        id: props?.id ?? props?.requestID ?? props?.requestId ?? null,
        sessionID: sessionId,
        permission: props?.permission ?? props?.type ?? 'unknown',
        patterns: Array.isArray(props?.patterns) ? props.patterns : [],
        metadata: (props?.metadata && typeof props.metadata === 'object') ? props.metadata : {},
        always: Array.isArray(props?.always) ? props.always : [],
      };

      // Dedupe against the reconciliation safety net: whichever path (live SSE
      // or reconcile) reaches a given request id first wins; the other skips.
      // Recorded synchronously before the async send so a concurrent reconcile
      // pass can't double-surface the same permission.
      if (permission.id) {
        // Hard stop: a previous Approve/Deny message for this exact request is
        // still actionable. This guards against the in-memory `forwarded` set
        // being pruned (or lost) while the permission is genuinely pending, the
        // root cause of approvals arriving duplicated many times.
        if (hasLiveApprovalForRequest(permission.id)) return;
        if (forwardedPermissionIds.has(permission.id)) return;
        forwardedPermissionIds.add(permission.id);
      }

      // Resolve the directory OpenCode needs for the reply. Priority:
      //   1. the event envelope's directory (authoritative)
      //   2. directory already present on the permission metadata
      //   3. the surface's bound project path
      // Without a correct directory, POST /permission/{id}/reply silently
      // targets the wrong workspace and the request stays pending forever.
      const replyDirectory =
        envelopeDirectory || permission.metadata.directory || ctx.projectPath || null;
      if (replyDirectory) {
        permission.metadata.directory = permission.metadata.directory || replyDirectory;
        permission.metadata.sdkDirectory = permission.metadata.sdkDirectory || replyDirectory;
      }

      console.log('[PERMISSION]', `session=${sessionId} tool=${permission.permission} dir=${replyDirectory ?? 'none'} patterns=${permission.patterns.join(',')}`);

      // Permission mode (`/yolo`) — pre-decide approvals so the user isn't
      // prompted for every tool. Enforced here in core logic (not only in the
      // button UI) so it applies across every surface and execution path.
      const permissionMode = resolvePermissionMode({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
      });
      if (permissionMode !== 'ask' && shouldAutoApprove(permissionMode, permission.permission)) {
        if (typeof _respondToOpenCode === 'function' && permission.id) {
          _respondToOpenCode({
            sessionID: sessionId,
            requestID: permission.id,
            reply: 'once',
            directory: replyDirectory,
          }).catch((err) =>
            console.error('[PERMISSION] auto-approve reply failed:', err?.message ?? err),
          );
        }
        // The turn keeps running after an auto-approval — re-arm the typing
        // pulse that this handler stopped so the bot doesn't look idle.
        if (startTypingPulse) startTypingPulse(ctx);
        const label = PERMISSION_MODE_LABELS[permissionMode] ?? permissionMode;
        void postToSurface(
          ctx,
          `⚡ _Auto-approved (${escapeMd(label)}): \`${escapeMd(String(permission.permission))}\`_`,
        );
        return;
      }

      sendApprovalToSurface({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        permission,
        directory: replyDirectory,
      }).then((result) => {
        if (result && !result.ok) {
          // Release the dedupe slot so a later reconcile pass can retry.
          if (permission.id) forwardedPermissionIds.delete(permission.id);
          console.error('[PERMISSION] Failed to send approval to surface:', result.error);
        }
      }).catch((err) => {
        if (permission.id) forwardedPermissionIds.delete(permission.id);
        console.error('[PERMISSION] sendApprovalToSurface threw:', err?.message ?? err);
      });
      return;
    }

    // ── Question asked (the "ask" tool) — send options as components ───
    // Interactive session state: rendered at every verbosity level, exactly
    // like permission prompts.
    if (type === 'question.asked') {
      const sessionId = props?.sessionID ?? props?.sessionId ?? null;
      let ctx = sessionId ? sessionContexts.get(sessionId) : null;

      if (!ctx && sessionId && lookupMessengerTarget) {
        try {
          const binding = await lookupMessengerTarget(sessionId);
          if (binding) {
            ctx = {
              type: binding.type,
              token: binding.token,
              channelId: binding.targetKey,
              threadId: binding.threadId ?? null,
              projectPath: binding.projectPath ?? null,
            };
          }
        } catch {
          // lookup failed — fall through
        }
      }

      if (!ctx) {
        ctx = await ensureDefaultSessionContext(sessionId, { projectPath: envelopeDirectory });
      }

      if (!ctx) {
        console.log('[QUESTION]', `No surface for session=${sessionId} — cannot forward to messenger`);
        return;
      }

      // A question is blocking interactive UI — stop the typing indicator.
      stopTypingPulse(ctx);

      const request = {
        id: props?.id ?? props?.requestID ?? props?.requestId ?? null,
        sessionID: sessionId,
        questions: Array.isArray(props?.questions) ? props.questions : [],
      };
      if (!request.id || request.questions.length === 0) return;

      // Dedupe against the reconciliation safety net (see permission.asked).
      if (forwardedQuestionIds.has(request.id)) return;
      forwardedQuestionIds.add(request.id);

      const replyDirectory = envelopeDirectory || ctx.projectPath || null;
      console.log('[QUESTION]', `session=${sessionId} request=${request.id} questions=${request.questions.length} dir=${replyDirectory ?? 'none'}`);

      sendQuestionToSurface({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        request,
        directory: replyDirectory,
      }).then((result) => {
        if (result && !result.ok) {
          if (request.id) forwardedQuestionIds.delete(request.id);
          console.error('[QUESTION] Failed to send question to surface:', result.error);
        }
      }).catch((err) => {
        if (request.id) forwardedQuestionIds.delete(request.id);
        console.error('[QUESTION] sendQuestionToSurface threw:', err?.message ?? err);
      });
      return;
    }

    // ── Question answered/dismissed elsewhere (e.g. web UI) — strip the
    // stale components so the Discord buttons can't be clicked anymore.
    if (type === 'question.replied' || type === 'question.rejected') {
      const requestID = props?.requestID ?? props?.requestId ?? null;
      if (!requestID) return;
      for (const [questionId, qctx] of [...questionContexts.entries()]) {
        if (questionId === '_cleanup' || !qctx || qctx.requestID !== requestID) continue;
        questionContexts.delete(questionId);
        stripQuestionComponents(qctx);
      }
      return;
    }

    // ── Todo/plan updates — keep one live checklist message per turn ───
    if (type === 'todo.updated') {
      const sessionId = props?.sessionID ?? props?.sessionId ?? null;
      if (!sessionId) return;
      // Narrow: only mirror plans for sessions already bound to a surface;
      // a todo list alone should never spawn a mirror thread.
      const ctx = sessionContexts.get(sessionId);
      if (!ctx) return;
      const todos = Array.isArray(props?.todos) ? props.todos : [];
      scheduleTodoUpdate(ctx, sessionId, todos);
      return;
    }
  }

  // ── Pending approval/question reconciliation ──────────────────────────
  // SSE delivery of `permission.asked` / `question.asked` is best-effort: the
  // upstream OpenCode `/global/event` stream can drop and reconnect during a
  // long agent turn, and any interactive event emitted inside that gap is lost
  // — leaving the agent blocked on a reply the messenger never surfaced (the
  // request just hangs; switching to the web UI shows it pending). The web UI
  // recovers because it re-lists pending permissions/questions on resync; the
  // bridge had no equivalent safety net. We re-list pending items for every
  // bound directory (periodically and on every stream reconnect) and forward
  // anything not already sent. `forwarded*Ids` dedupes against the live SSE
  // path so a permission is never surfaced twice.
  const RECONCILE_INTERVAL_MS = 15_000;
  const forwardedPermissionIds = new Set();
  const forwardedQuestionIds = new Set();
  let reconcileTimer = null;
  let reconcileInFlight = false;

  function collectBoundDirectories() {
    const directories = new Set();
    try {
      for (const row of bridgeStore.list()) {
        if (row?.sessionId && typeof row.projectPath === 'string' && row.projectPath) {
          directories.add(row.projectPath);
        }
      }
    } catch {
      // store read failed — fall back to whatever live contexts we have
    }
    for (const ctx of sessionContexts.values()) {
      if (ctx?.projectPath) directories.add(ctx.projectPath);
    }
    // Query the unscoped endpoint last so a directory-attributed result wins
    // over the global one (first-seen wins below); it backstops anything not
    // tied to a known directory.
    directories.add('');
    return directories;
  }

  // Returns the parsed array, or null when the fetch itself failed — so the
  // caller can preserve dedupe state instead of pruning on a transient blip
  // (mirrors the "distinguish fetch failure from empty success" rule).
  async function listPendingInteractions(kind, directory) {
    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    let res;
    try {
      res = await opencodeFetch(`/${kind}${dirParam}`, { method: 'GET' });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    try {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return null;
    }
  }

  async function reconcilePendingInteractions() {
    if (reconcileInFlight || !globalEventHub) return;
    reconcileInFlight = true;
    try {
      const directories = collectBoundDirectories();

      // ── Permissions ──
      const pendingPermissions = new Map(); // id → { item, directory }
      let permFetchOk = false;
      for (const directory of directories) {
        const list = await listPendingInteractions('permission', directory);
        if (list === null) continue;
        permFetchOk = true;
        for (const item of list) {
          if (item && typeof item.id === 'string' && item.id && !pendingPermissions.has(item.id)) {
            pendingPermissions.set(item.id, { item, directory: directory || null });
          }
        }
      }
      if (permFetchOk) {
        for (const id of [...forwardedPermissionIds]) {
          // Keep the dedupe slot while an approval message is still live for
          // it, even if this snapshot momentarily doesn't list it — otherwise
          // the next snapshot that does list it re-forwards a duplicate.
          if (!pendingPermissions.has(id) && !hasLiveApprovalForRequest(id)) {
            forwardedPermissionIds.delete(id);
          }
        }
        for (const [id, { item, directory }] of pendingPermissions) {
          if (forwardedPermissionIds.has(id) || hasLiveApprovalForRequest(id)) continue;
          const replyDirectory = directory
            || (typeof item?.metadata?.directory === 'string' ? item.metadata.directory : undefined);
          try {
            console.log('[RECONCILE]', `forwarding missed permission ${id} session=${item?.sessionID ?? 'unknown'}`);
            await handleGlobalEvent({
              directory: replyDirectory,
              payload: { type: 'permission.asked', properties: item },
            });
          } catch (err) {
            console.error('[RECONCILE] permission forward failed:', err?.message ?? err);
          }
        }
      }

      // ── Questions ──
      const pendingQuestions = new Map();
      let questionFetchOk = false;
      for (const directory of directories) {
        const list = await listPendingInteractions('question', directory);
        if (list === null) continue;
        questionFetchOk = true;
        for (const item of list) {
          if (item && typeof item.id === 'string' && item.id && !pendingQuestions.has(item.id)) {
            pendingQuestions.set(item.id, { item, directory: directory || null });
          }
        }
      }
      if (questionFetchOk) {
        for (const id of [...forwardedQuestionIds]) {
          if (!pendingQuestions.has(id)) forwardedQuestionIds.delete(id);
        }
        for (const [id, { item, directory }] of pendingQuestions) {
          if (forwardedQuestionIds.has(id)) continue;
          try {
            console.log('[RECONCILE]', `forwarding missed question ${id} session=${item?.sessionID ?? 'unknown'}`);
            await handleGlobalEvent({
              directory: directory ?? undefined,
              payload: { type: 'question.asked', properties: item },
            });
          } catch (err) {
            console.error('[RECONCILE] question forward failed:', err?.message ?? err);
          }
        }
      }
    } finally {
      reconcileInFlight = false;
    }
  }

  let unsubscribeStatus = null;
  let unsubscribe = null;
  function ensureSubscribed() {
    if (unsubscribe) return;
    if (!globalEventHub) return;
    unsubscribe = globalEventHub.subscribeEvent(handleGlobalEvent);

    // Catch up immediately whenever the upstream stream (re)connects — a
    // reconnect means interactive events may have been missed during the gap.
    if (typeof globalEventHub.subscribeStatus === 'function' && !unsubscribeStatus) {
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (status?.type === 'connect') void reconcilePendingInteractions();
      });
    }

    // Periodic safety net for events missed without an observable disconnect.
    if (!reconcileTimer) {
      reconcileTimer = setInterval(() => {
        void reconcilePendingInteractions();
      }, RECONCILE_INTERVAL_MS);
      if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
    }

    // Surface anything already pending at subscribe time without waiting for
    // the first interval.
    void reconcilePendingInteractions();
  }

  /**
   * Run a parsed slash command against a messenger surface and return the
   * command handler's result (`{ reply }` or `null` for "not a command").
   *
   * This is the single source of truth for wiring the bridge store (bindings,
   * project defaults, global defaults) and the OpenCode adapter into
   * {@link executeMessengerCommand}. Both the inbound text pipeline
   * (`routeInbound` step 0) and the native slash-command pipeline
   * (`runCommand`) delegate here so the two can never drift apart.
   */
  // Per-surface caches so `/resume <n>` and `/fork <n>` indices stay stable
  // between the listing reply and the follow-up pick.
  /** @type {Map<string, Array<{ id: string }>>} */
  const resumeCandidatesCache = new Map();
  /** @type {Map<string, Array<{ id: string }>>} */
  const forkCandidatesCache = new Map();

  function firstTextOfMessage(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
    return '';
  }

  function lastAssistantTextOfMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const role = messages[i]?.info?.role ?? messages[i]?.role;
      if (role !== 'assistant') continue;
      const text = firstTextOfMessage(messages[i]);
      if (text) return text;
    }
    return '';
  }

  async function executeSurfaceCommand({
    command,
    type,
    token,
    channelId,
    threadId = null,
    sourceMessageId = null,
    from = null,
  }) {
    const hash = tokenHash(token);
    const stableKey = targetKey({ type, channelId, threadId: threadId ?? null });
    const stored = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
    const projectDefaults = stored?.projectPath
      ? bridgeStore.getProjectDefaults?.(stored.projectPath) ?? null
      : null;
    const globals = await resolveGlobalDefaults();
    const surface = { type, token, channelId, threadId: threadId ?? null };
    const surfaceCacheKey = `${type}:${hash}:${stableKey}`;

    /**
     * Spawn a new thread in the parent channel and bind it to a session.
     * Used by /resume, /fork and /new-worktree. When the command ran inside
     * a thread we hop up to the parent channel first.
     */
    const createBoundThread = async ({ name, sessionId, projectPath, projectLabel }) => {
      let hostChannelId = channelId;
      const parentId = await resolveParentChannelId({ token, channelId });
      if (parentId) hostChannelId = parentId;
      const thread = await startStandaloneDiscordThread({
        token,
        channelId: hostChannelId,
        name,
        userIds: from?.id ?? null,
      });
      if (!thread.ok || !thread.threadId) {
        return { ok: false, error: thread.error ?? 'thread creation failed' };
      }
      bridgeStore.bind({
        type,
        botTokenHash: hash,
        targetKey: targetKey({ type, channelId: hostChannelId, threadId: thread.threadId }),
        sessionId,
        projectPath: projectPath ?? null,
        projectLabel: projectLabel ?? null,
      });
      return { ok: true, threadId: thread.threadId };
    };

    const bridgeOps = {
      async startSession({ prompt }) {
        // Post a starter message in the channel, then run the normal inbound
        // pipeline anchored on it so the thread + session spin up exactly
        // like a typed message. When invoked
        // from inside a thread, hop up to the parent channel so the new
        // session gets its own thread instead of hijacking this one.
        const parentId = await resolveParentChannelId({ token, channelId });
        const hostChannelId = parentId ?? channelId;
        const starter = await sendDiscord({
          token,
          channelId: hostChannelId,
          content: `🚀 **Starting OpenCode session** — ${clipBlock(prompt.split('\n')[0] ?? prompt, 160)}`,
        });
        const result = await routeInbound({
          type,
          token,
          channelId: hostChannelId,
          threadId: null,
          sourceMessageId: starter.ok ? starter.id : null,
          text: prompt,
          from,
        });
        return result.ok
          ? { ok: true, threadId: result.threadId ?? null }
          : { ok: false, error: result.error ?? 'session start failed' };
      },

      async runShell({ command }) {
        // A native slash `/shell` reaches here without going through
        // routeInbound, so make sure we're subscribed to the event stream —
        // otherwise the shell result's SSE parts would never be mirrored.
        ensureSubscribed();
        // Resolve OR create a session so `/shell` (and `!pwd`) work even before
        // any chat message has spun one up — the user shouldn't have to "send a
        // regular message first". This auto-resolves the project (channel slug /
        // single project) and binds a fresh session to this surface, exactly
        // like a normal first message would.
        let resolved;
        try {
          resolved = await resolveOrCreateSession({
            type,
            token,
            channelId,
            threadId: threadId ?? null,
            projectPath: stored?.projectPath ?? null,
            projectLabel: stored?.projectLabel ?? null,
          });
        } catch (e) {
          return { ok: false, error: e?.message ?? 'could not start a session for the shell command' };
        }
        const sessionId = resolved?.sessionId ?? null;
        if (!sessionId) return { ok: false, error: 'could not resolve a session for this conversation' };
        const projectPath = resolved.projectPath ?? stored?.projectPath ?? null;
        // Bind a context for this surface so the shell command's result (which
        // streams back over SSE as a bash tool part) is mirrored to the exact
        // channel/thread it was issued from, instead of an auto-resolved
        // default. Reuse an existing context (active conversation) untouched.
        if (!sessionContexts.has(sessionId)) {
          sessionContexts.set(sessionId, {
            sessionId,
            type,
            token,
            channelId,
            threadId: threadId ?? null,
            projectPath,
            sentPartIds: new Set(),
            startedAt: Date.now(),
            lastError: null,
            verbosity: resolveVerbosity({ type, token, channelId, threadId: threadId ?? null }),
            from,
            source: type,
          });
        }
        // The shell endpoint requires a real agent (an empty/unknown one 500s),
        // so resolve a concrete one: surface override → project default →
        // global default → a discovered primary agent.
        const agent = await resolveShellAgent({
          surfaceAgent: stored?.agentOverride ?? null,
          projectAgent: projectDefaults?.agentDefault ?? null,
          globalAgent: globals.agent ?? null,
        });
        const model =
          stored?.modelOverride ?? projectDefaults?.modelDefault ?? globals.model ?? null;
        return opencodeAdapter.runShell(sessionId, projectPath, command, {
          modelOverride: model,
          agentOverride: agent,
        });
      },

      async listResumeCandidates() {
        // Unbound channels fall back to the auto-resolved project so /resume
        // works before the first message has bound the surface.
        let projectDir = stored?.projectPath ?? null;
        if (!projectDir) {
          const auto = await autoResolveProject({ type, token, channelId, threadId }).catch(() => null);
          projectDir = auto?.projectPath ?? null;
        }
        const sessions = await opencodeAdapter.listSessions(projectDir ?? undefined).catch(() => []);
        const bound = new Set(
          bridgeStore.list({ type, botTokenHash: hash })
            .map((b) => b.sessionId)
            .filter(Boolean),
        );
        const candidates = (sessions ?? [])
          .filter((s) => s?.id && !bound.has(s.id))
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
          .slice(0, 10)
          .map((s) => ({
            id: s.id,
            title: s.title ?? '(untitled)',
            when: s.time?.updated ? new Date(s.time.updated).toLocaleString() : '',
          }));
        resumeCandidatesCache.set(surfaceCacheKey, candidates);
        return candidates;
      },

      async resumeSession({ ref }) {
        let projectDir = stored?.projectPath ?? null;
        if (!projectDir) {
          const auto = await autoResolveProject({ type, token, channelId, threadId }).catch(() => null);
          projectDir = auto?.projectPath ?? null;
        }
        let target = null;
        const index = /^\d{1,2}$/.test(ref) ? Number.parseInt(ref, 10) : null;
        if (index != null) {
          const cached = resumeCandidatesCache.get(surfaceCacheKey)
            ?? await this.listResumeCandidates();
          target = cached[index - 1] ?? null;
          if (!target) return { ok: false, error: `no session #${index} in the /resume list.` };
        } else {
          const sessions = await opencodeAdapter.listSessions(projectDir ?? undefined).catch(() => []);
          const match = (sessions ?? []).filter((s) => s?.id && String(s.id).startsWith(ref));
          if (match.length === 0) return { ok: false, error: `no session matching \`${ref}\`.` };
          if (match.length > 1) return { ok: false, error: `\`${ref}\` is ambiguous (${match.length} matches) — paste more of the id.` };
          target = { id: match[0].id, title: match[0].title ?? '(untitled)' };
        }

        const session = await opencodeAdapter.getSession(target.id, projectDir ?? undefined);
        const title = session?.title ?? target.title ?? '(untitled)';
        const projectPath = session?.directory ?? projectDir ?? null;

        const thread = await createBoundThread({
          name: `Resume: ${clipBlock(title, 80)}`,
          sessionId: target.id,
          projectPath,
          projectLabel: stored?.projectLabel ?? null,
        });
        if (!thread.ok) return thread;

        // Show the most recent assistant response so the user has context
        // (only the last reply is shown to avoid flooding the thread).
        const messages = await opencodeAdapter.listMessages(target.id, projectPath ?? undefined);
        const lastText = lastAssistantTextOfMessages(messages ?? []);
        if (lastText) {
          await postMessengerSurface(
            { type, token, channelId: thread.threadId, threadId: null },
            `_Last assistant response:_\n${clipBlock(lastText, 1500)}`,
          );
        }
        return {
          ok: true,
          threadId: thread.threadId,
          title,
          loadedNote: messages?.length ? `Loaded ${messages.length} messages.` : '',
        };
      },

      async listForkCandidates() {
        if (!stored?.sessionId) return [];
        const messages = await opencodeAdapter.listMessages(stored.sessionId, stored?.projectPath ?? undefined);
        const candidates = (messages ?? [])
          .filter((m) => (m?.info?.role ?? m?.role) === 'user')
          .map((m) => {
            const id = m?.info?.id ?? m?.id ?? null;
            const created = m?.info?.time?.created ?? m?.time?.created ?? null;
            const preview = clipBlock(firstTextOfMessage(m) || '(no text)', 80);
            return id ? { id, preview, when: created ? new Date(created).toLocaleString() : '' } : null;
          })
          .filter(Boolean)
          // Hide synthetic / injected messages (memory + scheduling blocks).
          .filter((m) => !m.preview.startsWith('<project-memory>') && !m.preview.startsWith('<scheduling>'))
          .slice(-25);
        forkCandidatesCache.set(surfaceCacheKey, candidates);
        return candidates;
      },

      async forkSession({ index }) {
        if (!stored?.sessionId) return { ok: false, error: 'no session bound to this conversation.' };
        const cached = forkCandidatesCache.get(surfaceCacheKey)
          ?? await this.listForkCandidates();
        const target = cached[index - 1];
        if (!target) return { ok: false, error: `no message #${index} in the /fork list.` };

        const forked = await opencodeAdapter.forkSession(
          stored.sessionId,
          target.id,
          stored?.projectPath ?? undefined,
        );
        if (!forked.ok) return forked;

        const session = await opencodeAdapter.getSession(stored.sessionId, stored?.projectPath ?? undefined);
        const baseTitle = session?.title ?? stored?.projectLabel ?? 'session';
        const thread = await createBoundThread({
          name: `Fork: ${clipBlock(baseTitle, 80)}`,
          sessionId: forked.sessionId,
          projectPath: stored?.projectPath ?? null,
          projectLabel: stored?.projectLabel ?? null,
        });
        if (!thread.ok) return thread;
        return { ok: true, threadId: thread.threadId };
      },

      async queueMessage({ text }) {
        const busy = stored?.sessionId ? busySessions.has(stored.sessionId) : false;
        if (busy) {
          const key = queueKeyFor(surface);
          const queue = surfaceQueues.get(key) ?? [];
          if (queue.length >= MAX_QUEUE_LENGTH) {
            return { ok: false, error: `queue is full (${MAX_QUEUE_LENGTH} messages).` };
          }
          queue.push({ text, from, queuedAt: Date.now() });
          surfaceQueues.set(key, queue);
          return { ok: true, queued: true, position: queue.length };
        }
        // Nothing running — send straight away through the normal pipeline.
        const result = await routeInbound({
          type,
          token,
          channelId,
          threadId: threadId ?? null,
          text,
          from,
        });
        return result.ok
          ? { ok: true, queued: false }
          : { ok: false, error: result.error ?? 'send failed' };
      },

      async clearQueue() {
        const key = queueKeyFor(surface);
        const queue = surfaceQueues.get(key);
        const cleared = queue?.length ?? 0;
        surfaceQueues.delete(key);
        return cleared;
      },

      async toggleMentionMode() {
        const next = !getMentionMode({ type, token, channelId });
        setMentionMode({ type, token, channelId }, next);
        return next;
      },

      async newWorktree({ name }) {
        const projectPath = stored?.projectPath ?? null;
        if (!projectPath) return { ok: false, error: 'no project bound to this conversation.' };
        const effectiveName = sanitizeWorktreeName(name || `wt-${Date.now().toString(36)}`);
        const created = await createBridgeWorktree({ projectPath, name: effectiveName });
        if (!created.ok) return created;

        // Bind a fresh session running inside the worktree to a new thread.
        // Untitled — OpenCode names it from the first message.
        let sessionId;
        try {
          sessionId = await createOpencodeSession({ projectPath: created.path });
        } catch (err) {
          return { ok: false, error: `worktree created at ${created.path}, but session creation failed: ${err?.message ?? 'unknown'}` };
        }
        const thread = await createBoundThread({
          name: `⬦ worktree: ${clipBlock(created.branch, 80)}`,
          sessionId,
          projectPath: created.path,
          projectLabel: `${stored?.projectLabel ?? 'project'} (${created.branch})`,
        });
        if (!thread.ok) {
          return { ok: false, error: `worktree + session ready, but thread creation failed: ${thread.error}` };
        }
        return { ok: true, path: created.path, branch: created.branch, threadId: thread.threadId };
      },

      async scheduleTask({ when, prompt, model, agent }) {
        if (!projectConfigRuntime) {
          return { ok: false, error: 'the project scheduler is not available on this server.' };
        }
        // The task lives in the surface's bound project — same store the web
        // UI's Scheduled-tasks dialog manages.
        let projectDir = stored?.projectPath ?? null;
        if (!projectDir) {
          const auto = await autoResolveProject({ type, token, channelId, threadId }).catch(() => null);
          projectDir = auto?.projectPath ?? null;
        }
        const projectId = await resolveProjectIdForPath(projectDir);
        if (!projectId) {
          return { ok: false, error: 'no project bound to this conversation — send a message first to bind one.' };
        }

        const parsed = parseScheduleWhen(when);
        if (parsed.error) return { ok: false, error: parsed.error };

        // The project scheduler requires an explicit model. Resolution:
        // command pin → surface override → project default → global default.
        let modelStr = model ?? stored?.modelOverride ?? null;
        if (!modelStr && projectDir) {
          modelStr = bridgeStore.getProjectDefaults?.(projectDir)?.modelDefault ?? null;
        }
        if (!modelStr) modelStr = globals.model ?? null;
        if (!modelStr || !/^[^/]+\/.+$/.test(modelStr)) {
          return {
            ok: false,
            error: 'no model resolved — pin one with `model=provider/model` or set a default via `/model`.',
          };
        }
        const slash = modelStr.indexOf('/');
        const providerID = modelStr.slice(0, slash);
        const modelID = modelStr.slice(slash + 1);
        const agentName = agent ?? stored?.agentOverride ?? null;

        try {
          const result = await projectConfigRuntime.upsertScheduledTask(projectId, {
            name: clipBlock(prompt.split('\n')[0].trim(), 60) || 'Discord task',
            enabled: true,
            schedule: parsed.schedule,
            execution: {
              prompt,
              providerID,
              modelID,
              ...(agentName ? { agent: agentName } : {}),
            },
          });
          await scheduledTasksRuntime?.syncProject?.(projectId);
          // Re-read so the reply includes the computed nextRunAt.
          const tasks = await projectConfigRuntime.listScheduledTasks(projectId);
          const task = tasks.find((t) => t.id === result.task.id) ?? result.task;
          return { ok: true, task, projectId };
        } catch (err) {
          return { ok: false, error: err?.message ?? 'failed to save the scheduled task' };
        }
      },

      async listSchedules() {
        if (!projectConfigRuntime) return [];
        let projectDir = stored?.projectPath ?? null;
        if (!projectDir) {
          const auto = await autoResolveProject({ type, token, channelId, threadId }).catch(() => null);
          projectDir = auto?.projectPath ?? null;
        }
        const projectId = await resolveProjectIdForPath(projectDir);
        if (!projectId) return [];
        return projectConfigRuntime.listScheduledTasks(projectId);
      },

      async deleteSchedule(id) {
        if (!projectConfigRuntime) return false;
        let projectDir = stored?.projectPath ?? null;
        if (!projectDir) {
          const auto = await autoResolveProject({ type, token, channelId, threadId }).catch(() => null);
          projectDir = auto?.projectPath ?? null;
        }
        const projectId = await resolveProjectIdForPath(projectDir);
        if (!projectId) return false;
        try {
          const result = await projectConfigRuntime.deleteScheduledTask(projectId, id);
          await scheduledTasksRuntime?.syncProject?.(projectId);
          return Boolean(result?.deleted ?? true);
        } catch {
          return false;
        }
      },

      describeSchedule,

      async mergeWorktree() {
        const worktreeDir = stored?.projectPath ?? null;
        if (!worktreeDir) return { ok: false, error: 'no project bound to this conversation.' };
        const result = await mergeBridgeWorktree({ worktreeDir });
        if (result.ok || !result.conflict) return result;

        // Conflict — hand resolution to the model.
        let promptSent = false;
        if (stored?.sessionId) {
          try {
            await sendOpencodePrompt({
              sessionId: stored.sessionId,
              projectPath: worktreeDir,
              text: MERGE_CONFLICT_PROMPT,
            });
            promptSent = true;
          } catch {
            promptSent = false;
          }
        }
        return { ...result, promptSent };
      },
    };

    return executeMessengerCommand({
      command,
      ctx: sourceMessageId ? { ...surface, sourceMessageId } : surface,
      opencode: opencodeAdapter,
      binding: {
        sessionId: stored?.sessionId || null,
        projectPath: stored?.projectPath ?? null,
        projectLabel: stored?.projectLabel ?? null,
        modelOverride: stored?.modelOverride ?? null,
        agentOverride: stored?.agentOverride ?? null,
        variantOverride: stored?.variantOverride ?? null,
        verbosityOverride: stored?.verbosityOverride ?? null,
        verbosityDefault: bridgeStore.getVerbosityDefault?.(type) ?? null,
        permissionModeOverride: stored?.permissionModeOverride ?? null,
        permissionModeDefault: bridgeStore.getPermissionModeDefault?.(type) ?? null,
        projectDefaults,
        globalDefaultModel: globals.model,
        globalDefaultAgent: globals.agent,
      },
      surfaceMutators: {
        async setOverrides(changes) {
          bridgeStore.setOverrides({ type, botTokenHash: hash, targetKey: stableKey, ...changes });
          if (changes.verbosityOverride !== undefined) {
            applyPreferencesToActiveTurn({ type, token, channelId, threadId });
          }
        },
        async setVerbosityDefault(level) {
          bridgeStore.setVerbosityDefault(type, level);
          applyPreferencesToActiveTurn({ type, token, channelId, threadId });
        },
        async setPermissionModeDefault(mode) {
          bridgeStore.setPermissionModeDefault(type, mode);
        },
        async unbindSession() {
          bridgeStore.unbindSession({ type, botTokenHash: hash, targetKey: stableKey });
        },
        async setProjectDefaults(changes) {
          if (!stored?.projectPath) return;
          bridgeStore.setProjectDefaults({
            projectPath: stored.projectPath,
            projectLabel: stored.projectLabel,
            ...changes,
          });
          if (changes.verbosityDefault !== undefined) {
            applyPreferencesToActiveTurn({ type, token, channelId, threadId });
          }
        },
      },
      bridgeOps,
    });
  }

  // --- Inbound: bridge a messenger message into OpenCode -----------------
  /**
   * @param {object} args
   * @param {'discord'} args.type
   * @param {string} args.token
   * @param {string} args.channelId
   * @param {string|null} [args.threadId]
   * @param {string} [args.sourceMessageId] - the Discord message id we should
   *                                          start a thread off of (Discord only).
   * @param {string} args.text
   * @param {string|null} [args.projectPath]
   * @param {string|null} [args.projectLabel]
   * @param {object} [args.from]
   */
  async function routeInbound({
    type,
    token,
    channelId,
    threadId,
    sourceMessageId,
    text,
    projectPath,
    projectLabel,
    from,
    attachments = null,
    // Per-call model/agent pins (scheduled tasks). Highest priority —
    // above surface overrides, project defaults and global defaults.
    modelOverride: pinnedModel = null,
    agentOverride: pinnedAgent = null,
  }) {
    // Attachments: text files inline as <attachment> blocks,
    // images/PDFs forwarded as file parts, voice messages transcribed via the
    // configured STT server. An attachment-only message is allowed — the
    // attachment content becomes the prompt.
    let extraFileParts = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const sttAvailable = await isSttConfigured();
      const processed = await processDiscordAttachments({
        attachments,
        transcribe: sttAvailable
          ? ({ audioBuffer, mimeType }) => transcribeVoiceAttachment({ audioBuffer, mimeType })
          : null,
      });
      extraFileParts = processed.fileParts;
      text = composePromptText({
        body: text,
        textBlocks: processed.textBlocks,
        transcripts: processed.transcripts,
      });
      if (processed.notes.length > 0) {
        await postMessengerSurface(
          { type, token, channelId, threadId: threadId ?? null },
          processed.notes.map((n) => `⚠ ${n}`).join('\n'),
        ).catch(() => {});
      }
      if ((!text || text.trim().length === 0) && extraFileParts.length > 0) {
        text = 'Please look at the attached file(s).';
      }
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'empty text' };
    }
    ensureSubscribed();

    // Remember who talked to the bot — web-created mirror threads add this
    // user as a member so they appear in their Discord sidebar.
    if (type === 'discord' && from?.id) {
      rememberLastActiveDiscordUser(token, from.id);
    }

    // -----------------------------------------------------------------
    // Step 0 — Slash command interceptor
    //
    // /help, /status, /abort, /new, /undo, /redo, /compact, /summary,
    // /init, /review, /model, /agent, /sessions — these are handled
    // BEFORE bootstrap dialogue and BEFORE thread creation. They never
    // reach OpenCode as a prompt; the bot replies inline.
    //
    // Unknown /commands fall through to the normal pipeline (so
    // OpenCode-registered user commands like /changelog still work via
    // the existing session.command machinery).
    // -----------------------------------------------------------------
    // Discord reserves `/` for its native slash-command UI, so accept a
    // leading `!` there as an alias for `/` — `!status` runs the same console
    // command as `/status`.
    let parsedCmd = parseLeadingCommand(text, { allowBang: type === 'discord' });
    // On Discord, `!` doubles as the shell prefix (matching the web chat where
    // `!cmd` runs a shell command). A bang-prefixed token that ISN'T a known
    // console command — e.g. `!pwd`, `!ls -la`, `!git status` — is therefore a
    // shell command, not a failed console command. We rewrite it into `/shell`
    // so it runs via the same pipeline as `!shell <cmd>` / native `/shell`.
    if (
      type === 'discord' &&
      text.trim().startsWith('!') &&
      (!parsedCmd || !isKnownMessengerCommand(parsedCmd.name))
    ) {
      const shellCommand = text.trim().slice(1).trim();
      if (shellCommand) {
        parsedCmd = { name: 'shell', args: shellCommand, body: '' };
      }
    }
    if (parsedCmd) {
      const surface = { type, token, channelId, threadId: threadId ?? null };
      const result = await executeSurfaceCommand({
        command: parsedCmd,
        type,
        token,
        channelId,
        threadId: threadId ?? null,
        sourceMessageId,
        from,
      });
      if (result) {
        await postMessengerSurface(surface, result.reply);
        broadcastEvent?.('messenger.bridge.command_handled', {
          type,
          channelId,
          threadId,
          command: parsedCmd.name,
        });
        return { ok: true, handledCommand: parsedCmd.name };
      }
      // null → unknown command; fall through.
    }

    // -----------------------------------------------------------------
    // Step 1 — Bootstrap dialogue
    //
    // Done BEFORE any thread creation, so the dialogue is conducted in
    // the user's original surface (channel or thread). Only after we know
    // which project this conversation belongs to do we spawn a thread and
    // resolve a session. This avoids the bug where the reply to our
    // bootstrap prompt landed on a different surface key than the stash.
    // -----------------------------------------------------------------
    const surfaceKey = bootstrapKey({ type, channelId, threadId: threadId ?? null });
    if (bootstrapProject) {
      const pending = bootstrapPending.get(surfaceKey);
      const reply = parseBootstrapReply(text);

      if (pending && reply) {
        try {
          const result = await bootstrapProject(reply);
          if (!result.ok || !result.project) {
            await postMessengerSurface(
              { type, token, channelId, threadId: threadId ?? null },
              `⚠ Could not bootstrap project: ${escapeMd(clipBlock(result.error ?? 'unknown error', 400))}`,
            );
            return { ok: false, error: result.error ?? 'bootstrap failed' };
          }
          bootstrapPending.delete(surfaceKey);
          await postMessengerSurface(
            { type, token, channelId, threadId: threadId ?? null },
            `✓ Project ready: *${escapeMd(result.project.label ?? result.project.path)}* → ${escapeMd(result.project.path)}\nOpenChamber agent will use this directory from now on. Re-sending your earlier message…`,
          );
          // Recurse with the stashed original text + the now-known project.
          // sourceMessageId remains from the ORIGINAL message so the thread
          // (when we create it below) is anchored on the user's first
          // message.
          return routeInbound({
            type,
            token,
            channelId,
            threadId: threadId ?? null,
            sourceMessageId: pending.sourceMessageId ?? sourceMessageId,
            text: pending.originalText,
            projectPath: result.project.path,
            projectLabel: result.project.label,
            from,
          });
        } catch (err) {
          await postMessengerSurface(
            { type, token, channelId, threadId: threadId ?? null },
            `⚠ Could not bootstrap project: ${escapeMd(clipBlock(err?.message ?? String(err), 400))}`,
          );
          return { ok: false, error: err?.message ?? 'bootstrap failed' };
        }
      }

      // No pending dialogue — decide whether to open one.
      if (!projectPath) {
        const hash = tokenHash(token);
        const keyForStore = targetKey({ type, channelId, threadId: threadId ?? null });
        const stored = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: keyForStore });
        if (!stored?.sessionId) {
          const auto = await autoResolveProject({
            type,
            token,
            channelId,
            threadId: threadId ?? null,
          });
          if (!auto || auto.autoResolved !== 'slug-match') {
            bootstrapPending.set(surfaceKey, {
              type,
              token,
              channelId,
              threadId: threadId ?? null,
              sourceMessageId,
              originalText: text,
              askedAt: Date.now(),
            });
            const intro =
              type === 'discord'
                ? `**OpenChamber agent — new channel detected**`
                : `🤖 *OpenChamber agent — new chat detected*`;
            const guidance = [
              intro,
              ``,
              `I don't have a project bound to this ${type === 'discord' ? 'channel' : 'chat'} yet.`,
              `Reply with one of:`,
              `• \`clone <git-url>\` — git-clone the repo into OpenChamber agent's projects folder`,
              `• \`path </absolute/path>\` — use an existing folder on the server`,
              `• \`new <project-name>\` — create an empty project`,
              ``,
              `Your message _"${clipBlock(text, 120)}"_ is stashed; I'll re-send it to OpenChamber agent once the project is ready.`,
            ].join('\n');
            await postMessengerSurface(
              { type, token, channelId, threadId: threadId ?? null },
              guidance,
            );
            broadcastEvent?.('messenger.bridge.bootstrap_prompt', {
              type,
              channelId,
              threadId: threadId ?? null,
              originalText: text,
            });
            return { ok: true, awaitingBootstrap: true };
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // Step 2 — Spawn a thread on the user's message (Discord only).
    // We only get here once we know what project this conversation
    // belongs to.
    // -----------------------------------------------------------------
    let effectiveThreadId = threadId ?? null;
    if (type === 'discord' && !effectiveThreadId && sourceMessageId) {
      // Initial name: whole message collapsed to one line,
      // capped at 80 chars. Renamed later to OpenCode's generated title.
      const threadName = text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'OpenChamber agent';
      const thread = await startDiscordThread({
        token,
        channelId,
        messageId: sourceMessageId,
        name: threadName,
        userId: from?.id,
      });
      if (thread.ok && thread.threadId) {
        effectiveThreadId = thread.threadId;
      }
      // If thread creation failed (e.g. message is already in a thread, or
      // bot lacks Create Public Threads), keep going in the existing
      // surface — gracefully falling back is better than refusing.
    }

    let sessionId;
    let effectiveProjectPath = projectPath ?? null;
    let sessionCreated = false;
    try {
      const resolved = await resolveOrCreateSession({
        type,
        token,
        channelId,
        threadId: effectiveThreadId,
        projectPath,
        projectLabel,
      });
      sessionId = resolved.sessionId;
      effectiveProjectPath = resolved.projectPath ?? effectiveProjectPath;
      sessionCreated = Boolean(resolved.created);
    } catch (err) {
      return { ok: false, error: err?.message ?? 'session resolve failed' };
    }

    // Project memory: a brand-new session's first prompt
    // carries the project's MEMORY.md as persistent context. The scheduling
    // instructions ride along so the agent can self-serve reminders /
    // recurring tasks via the local API when the user asks.
    // Remember the user's raw prompt (before any project-memory / scheduling
    // context is prepended) so the `/model` wizard's "Send last message" button
    // can replay it under a freshly-chosen model.
    rememberLastPrompt(
      { type, token, channelId, threadId: effectiveThreadId },
      text,
    );

    if (sessionCreated) {
      const contextBlocks = [];
      const memory = await readProjectMemory(effectiveProjectPath);
      if (memory) contextBlocks.push(`<project-memory>\n${memory}\n</project-memory>`);
      const scheduling = await buildSchedulingInstructions({
        projectPath: effectiveProjectPath,
      }).catch(() => null);
      if (scheduling) contextBlocks.push(scheduling);
      const discordInstructions = await buildDiscordInstructions().catch(() => null);
      if (discordInstructions) contextBlocks.push(discordInstructions);
      if (contextBlocks.length > 0) {
        text = `${contextBlocks.join('\n\n')}\n\n${text}`;
      }
    }

    // A new message supersedes unanswered permission requests for this
    // session — reject them and strip stale buttons.
    await rejectPendingApprovalsForSession(sessionId).catch(() => {});

    // Bind context so the SSE handler routes outbound parts here.
    const existingCtx = sessionContexts.get(sessionId);
    if (existingCtx) {
      // Same surface, follow-up message — keep typing pulse alive but reset
      // the dedup set so the next turn's parts post.
      existingCtx.sentPartIds.clear();
      existingCtx.startedAt = Date.now();
      existingCtx.lastError = null;
      // Keep the resolved directory current — it's needed for the session.idle
      // footer and (critically) for replying to permission requests.
      if (effectiveProjectPath) existingCtx.projectPath = effectiveProjectPath;
    } else {
      const ctx = {
        sessionId,
        type,
        token,
        channelId,
        threadId: effectiveThreadId,
        projectPath: effectiveProjectPath,
        sentPartIds: new Set(),
        startedAt: Date.now(),
        lastError: null,
        verbosity: DEFAULT_VERBOSITY,
        from,
        // Mark origin surface so we never echo user parts back to the
        // same messenger they came from (prevents duplication).
        source: type,
      };
      sessionContexts.set(sessionId, ctx);
    }
    const ctx = sessionContexts.get(sessionId);
    // New turn — clear any prior error state so its idle posts a real footer,
    // and re-arm idle settling so this turn's session.idle isn't deduped.
    ctx.errored = false;
    ctx.idleSettled = false;
    // Re-resolve verbosity each turn so a mid-session `/verbosity` change (or a
    // UI default change) takes effect on the next prompt.
    ctx.verbosity = resolveVerbosity({ type, token, channelId, threadId: effectiveThreadId });
    startTypingPulse(ctx);

    // The agent asked a question and the user typed a reply instead of
    // clicking an option → the text IS the (custom) answer. Send it through
    // question.reply so the blocked turn resumes; never as a second prompt.
    if (await answerPendingQuestionWithText(sessionId, text)) {
      void postToSurface(ctx, '✅ _Reply sent as the answer to the question above._');
      broadcastEvent?.('messenger.bridge.question_answered', {
        type,
        channelId,
        threadId: effectiveThreadId,
        sessionId,
      });
      return { ok: true, sessionId, threadId: effectiveThreadId, answeredQuestion: true };
    }

    // Remember this prompt so OpenCode's `user` part echo isn't mirrored back
    // into the originating messenger surface (see consumeMessengerInbound).
    rememberMessengerInbound(sessionId, text);

    // Pull per-surface model/agent overrides (set via /model and /agent).
    //
    // Resolution order:
    //   1. thread-keyed binding (where the bot answers)
    //   2. parent channel id  — so an override set in the channel BEFORE a
    //      thread was spawned still applies to the conversation that
    //      thread hosts
    //   3. project default    — settable from `/model default <X>` or the
    //      OpenChamber UI; applies to every Discord surface
    //      that lands in this project
    //   4. OpenCode default   — nothing set, server picks
    let modelOverride = pinnedModel ?? null;
    let agentOverride = pinnedAgent ?? null;
    // Thinking-effort (model variant). Only meaningful alongside a surface- or
    // project-set model, so it's resolved from the SAME source that supplied the
    // model and never inherited across a different model layer.
    let variantOverride = null;
    try {
      const hash = tokenHash(token);
      const stableKey = targetKey({ type, channelId, threadId: effectiveThreadId });
      const surfaceRow = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
      if (!modelOverride && surfaceRow?.modelOverride) {
        modelOverride = surfaceRow.modelOverride;
        variantOverride = surfaceRow.variantOverride ?? null;
      }
      agentOverride = agentOverride ?? surfaceRow?.agentOverride ?? null;

      // Parent channel fallback (Discord follow-ups in a thread carry a
      // different surface key than the channel where /model was first set).
      if ((!modelOverride || !agentOverride) && stableKey !== String(channelId)) {
        const parent = bridgeStore.lookup({
          type,
          botTokenHash: hash,
          targetKey: String(channelId),
        });
        if (parent) {
          if (!modelOverride && parent.modelOverride) {
            modelOverride = parent.modelOverride;
            variantOverride = parent.variantOverride ?? null;
          }
          agentOverride = agentOverride ?? parent.agentOverride ?? null;
        }
      }

      // Project default fallback — the layer the user can set once and
      // have it apply everywhere a session lands in this project.
      if ((!modelOverride || !agentOverride) && effectiveProjectPath) {
        const pd = bridgeStore.getProjectDefaults?.(effectiveProjectPath);
        if (pd) {
          if (!modelOverride && pd.modelDefault) {
            modelOverride = pd.modelDefault;
            variantOverride = pd.variantDefault ?? null;
          }
          agentOverride = agentOverride ?? pd.agentDefault ?? null;
        }
      }

      // OpenChamber-wide default fallback — the same Settings → Defaults model
      // the web chat uses. Applied before letting OpenCode pick on its own, so
      // the messenger doesn't silently run on some unexpected provider default.
      if (!modelOverride || !agentOverride) {
        const globals = await resolveGlobalDefaults();
        if (!modelOverride && globals.model) {
          modelOverride = globals.model;
          variantOverride = globals.variant ?? null;
        }
        agentOverride = agentOverride ?? globals.agent ?? null;
      }
    } catch {
      // ignore — overrides are optional
    }

    const sendPrompt = async () => {
      try {
        await sendOpencodePrompt({
          sessionId,
          projectPath: effectiveProjectPath,
          text,
          modelOverride,
          agentOverride,
          variantOverride,
          extraParts: extraFileParts,
        });
      } catch (err) {
        const errMsg = err?.message ?? 'prompt failed';
        stopTypingPulse(ctx);
        await postToSurface(ctx, `⚠ OpenChamber agent could not reach OpenCode: ${escapeMd(clipBlock(errMsg, 300))}`);
        return { ok: false, sessionId, threadId: effectiveThreadId, error: errMsg };
      }

      broadcastEvent?.('messenger.bridge.inbound', {
        type,
        channelId,
        threadId: effectiveThreadId,
        sessionId,
        text,
      });

      return { ok: true, sessionId, threadId: effectiveThreadId };
    };

    // A plain message (not /queue'd) supersedes any in-flight turn: cancel the
    // current work and run this one as soon as the aborted turn settles. /queue
    // is the opt-in path for "wait for the current response to finish".
    if (busySessions.has(sessionId)) {
      // Broadcast the incoming message IMMEDIATELY so the UI can show it
      // before the current turn is aborted — avoids the "stuck" gap.
      broadcastEvent?.('messenger.discord.supersede_incoming', {
        type: 'discord',
        sessionId,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        text,
        from: from ? { username: from.username, firstName: from.firstName } : null,
        projectPath: effectiveProjectPath,
      });
      pendingSupersede.set(sessionId, sendPrompt);
      void postToSurface(ctx, '⏹ _Stopped the current turn to run your new message._');
      const aborted = await opencodeAdapter
        .abortSession(sessionId, effectiveProjectPath ?? undefined)
        .catch(() => ({ ok: false }));
      if (!aborted?.ok) {
        // Abort failed — don't strand the message; run it right away.
        pendingSupersede.delete(sessionId);
        return sendPrompt();
      }
      scheduleSupersedeFallback(sessionId);
      return { ok: true, sessionId, threadId: effectiveThreadId, superseded: true };
    }

    return sendPrompt();
  }

  function statusSnapshot({ type, token } = {}) {
    const hash = token ? tokenHash(token) : undefined;
    const bindings = bridgeStore.list({ type, botTokenHash: hash });
    const active = [...sessionContexts.values()].map((ctx) => ({
      type: ctx.type,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      sessionId: ctx.sessionId,
      startedAt: ctx.startedAt,
      lastError: ctx.lastError,
    }));
    return { bindings, active };
  }

  function isEnabled() {
    return true;
  }

  /**
   * Fetch available providers from OpenCode.
   * Returns { all: [...], connected: [...], default: string } or null.
   */
  async function fetchProviders() {
    const r = await opencodeFetch('/provider');
    if (!r.ok) return null;
    try {
      const d = await r.json();
      // OpenCode may return { all: [...], connected: [...], default } or { data: [...] }
      if (d && typeof d === 'object') {
        if (Array.isArray(d.all)) return { all: d.all, connected: d.connected ?? [], default: d.default ?? null };
        if (Array.isArray(d.data)) return { all: d.data, connected: d.data.map(p => p.id), default: d.default ?? null };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Execute a command directly and return the reply text, without posting to a surface.
   * Used by the gateway listener to respond to native slash commands.
   * Returns `{ reply: string }` on success, `null` if the command is not recognised.
   */
  /**
   * List the skills available to the agent for a messenger surface. Resolves
   * the surface's bound project path (so project-scoped skills show up) and
   * delegates to the injected `listSkills` accessor. Returns `[]` when no
   * accessor is wired or discovery fails.
   */
  async function listSurfaceSkills({ type, token, channelId, threadId = null }) {
    if (typeof listSkills !== 'function') return [];
    let projectPath = null;
    try {
      const hash = tokenHash(token);
      const stableKey = targetKey({ type, channelId, threadId: threadId ?? null });
      const stored = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
      projectPath = stored?.projectPath ?? null;
      if (!projectPath && stableKey !== String(channelId)) {
        const parent = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: String(channelId) });
        projectPath = parent?.projectPath ?? null;
      }
    } catch {
      // best-effort — fall back to project-less (user-level) skill discovery
    }
    try {
      const skills = await listSkills({ projectPath });
      return Array.isArray(skills) ? skills : [];
    } catch {
      return [];
    }
  }

  async function runCommand({ type, token, channelId, threadId, commandName, args = '', from = null }) {
    const text = `/${commandName}${args ? ' ' + args : ''}`;
    const parsedCmd = parseLeadingCommand(text);
    if (!parsedCmd) return null;
    const result = await executeSurfaceCommand({
      command: parsedCmd,
      type,
      token,
      channelId,
      threadId: threadId ?? null,
      from,
    });
    return result ?? null;
  }

  /**
   * Wire up the bridge to listen for approval button clicks from the
   * Discord listener and respond to OpenCode.
   *
   * @param {Function} respondToOpenCode - async ({ sessionID, requestID, reply, directory }) => void
   */
  /**
   * Direct handler for approval decisions from Discord button clicks.
   * Bypasses the global event hub to avoid routing issues.
   * Called by the Discord listener directly or via initApprovalListener.
   *
   * @param {string} approvalId
   * @param {'approve'|'approve-always'|'deny'} decision
   */
  function handleApprovalDecision(approvalId, decision) {
    if (!approvalId || !decision) return;
    const ctx = approvalContexts.get(approvalId);
    if (!ctx) {
      console.log('[BRIDGE] No approval context for', approvalId, '(expired or unknown) — likely already processed');
      return;
    }
    // Delete immediately so duplicate calls (direct + event hub fallback)
    // are idempotent. The 10-minute expiry timeout is harmless — deleting
    // a non-existent key is a no-op.
    approvalContexts.delete(approvalId);

    const reply = decision === 'approve' ? 'once' : decision === 'approve-always' ? 'always' : 'reject';
    console.log('[BRIDGE] Approval decision:', { approvalId, decision, reply, sessionID: ctx.sessionID, requestID: ctx.requestID });
    // Call respondToOpenCode if available
    if (typeof _respondToOpenCode === 'function') {
      _respondToOpenCode({
        sessionID: ctx.sessionID,
        requestID: ctx.requestID,
        reply,
        directory: ctx.directory || ctx.sdkDirectory,
      }).catch((err) => {
        console.error('[BRIDGE] Failed to respond to permission:', err?.message ?? err);
      });
    }
  }

  // Store the respondToOpenCode callback for handleApprovalDecision
  let _respondToOpenCode = null;

  function initApprovalListener(respondToOpenCode) {
    if (typeof respondToOpenCode !== 'function') return;
    _respondToOpenCode = respondToOpenCode;
    console.log('[BRIDGE] Approval listener initialized');

    // Also subscribe to global event hub as a fallback
    if (!globalEventHub) return;
    const handler = (event) => {
      const payload = event?.payload ?? event;
      if (!payload || typeof payload !== 'object') return;
      const type = payload.type ?? payload.event ?? null;
      if (type !== 'messenger.discord.approval') return;
      handleApprovalDecision(payload.approvalId, payload.decision);
    };
    const unsub = globalEventHub.subscribeEvent?.(handler);
    if (unsub) approvalContexts._cleanup = unsub;
  }

  // Sessions whose deletion this bridge initiated (Discord thread delete →
  // OpenCode session delete). The resulting `session.deleted` event must not
  // try to re-delete the Discord thread that triggered it.
  const sessionsBeingDeleted = new Set();

  /**
   * Clean up bridge state when a Discord thread is deleted or archived.
   * Always removes the in-memory context and the store binding. When the
   * thread was explicitly DELETED (`reason: 'deleted'`, the default), the
   * bound OpenCode session is deleted too so it disappears from the web UI —
   * mirroring deletes both ways. Archival (`reason: 'archived'`) only cleans
   * up bridge state; it must never destroy the session (a thread can
   * auto-archive after inactivity and be reopened later).
   *
   * Called from the Discord listener on THREAD_DELETE (deleted) and
   * THREAD_UPDATE-archived (archived) gateway events.
   */
  /**
   * Read the persisted Discord project→channel bindings. Returns a usable shape
   * even when settings access is unavailable so callers can no-op safely.
   */
  async function readDiscordBindings() {
    if (typeof readSettings !== 'function') return null;
    try {
      const settings = await readSettings();
      const discord = settings?.discord ?? {};
      const bindings = Array.isArray(discord.projectBindings) ? discord.projectBindings : [];
      return { discord, bindings };
    } catch {
      return null;
    }
  }

  /** Persist an updated bindings list, preserving the rest of the Discord block. */
  async function persistDiscordBindings(nextBindings, discord) {
    if (typeof persistSettings !== 'function') return;
    const normalized = (Array.isArray(nextBindings) ? nextBindings : [])
      .filter((b) => b && b.channelId && b.projectPath)
      .map((b) => ({
        channelId: String(b.channelId),
        projectPath: String(b.projectPath),
        projectLabel: b.projectLabel ? String(b.projectLabel) : undefined,
      }));
    try {
      await persistSettings({
        discord: { ...discord, projectBindings: normalized.length > 0 ? normalized : undefined },
      });
    } catch {
      // best-effort
    }
  }

  /**
   * A project's Discord channel was DELETED in Discord (gateway CHANNEL_DELETE).
   * Drop the persisted project→channel binding and the channel-level store
   * pre-bind, then broadcast so the web UI can unlink the project. We do NOT
   * delete the OpenChamber project itself — unlinking is the safe, reversible
   * mirror of a channel deletion (the workspace entry and its sessions stay).
   */
  async function handleChannelDeleted({ channelId, token }) {
    if (!channelId) return { ok: false };
    // Always clear the channel-level pre-bind for this token.
    if (token) {
      try {
        bridgeStore.unbind({ type: 'discord', botTokenHash: tokenHash(token), targetKey: String(channelId) });
      } catch {
        // best-effort
      }
    }
    const snap = await readDiscordBindings();
    if (!snap) return { ok: false };
    const match = snap.bindings.find((b) => b && String(b.channelId) === String(channelId));
    if (!match) return { ok: true, matched: false };
    await persistDiscordBindings(
      snap.bindings.filter((b) => String(b?.channelId) !== String(channelId)),
      snap.discord,
    );
    broadcastEvent?.('messenger.bridge.project_channel_removed', {
      type: 'discord',
      source: 'discord',
      channelId: String(channelId),
      projectPath: match.projectPath ?? null,
      projectLabel: match.projectLabel ?? null,
    });
    return { ok: true, matched: true, projectPath: match.projectPath ?? null };
  }

  /**
   * A project's Discord channel was RENAMED in Discord (gateway CHANNEL_UPDATE).
   * Update the persisted binding's projectLabel and broadcast so the web UI can
   * relabel the matching project. No-ops (no broadcast) when the new name still
   * slugs to the current label, which keeps a UI-originated rename from echoing.
   */
  async function handleChannelRenamed({ channelId, name }) {
    if (!channelId || !name) return { ok: false };
    const snap = await readDiscordBindings();
    if (!snap) return { ok: false };
    const idx = snap.bindings.findIndex((b) => b && String(b.channelId) === String(channelId));
    if (idx === -1) return { ok: true, matched: false };
    const match = snap.bindings[idx];
    if (slugifyProjectLabel(match.projectLabel ?? '') === slugifyProjectLabel(name)) {
      return { ok: true, matched: true, changed: false };
    }
    const nextLabel = labelFromChannelName(name);
    const next = snap.bindings.slice();
    next[idx] = { ...match, projectLabel: nextLabel };
    await persistDiscordBindings(next, snap.discord);
    broadcastEvent?.('messenger.bridge.project_channel_renamed', {
      type: 'discord',
      source: 'discord',
      channelId: String(channelId),
      channelName: String(name),
      projectPath: match.projectPath ?? null,
      projectLabel: nextLabel,
    });
    return { ok: true, matched: true, changed: true };
  }

  function handleThreadDeleted({ type, threadId, token, reason = 'deleted' }) {
    const bindings = bridgeStore.findByTargetKey({ type, targetKey: threadId });

    for (const b of bindings) {
      // Clean up in-memory session context (stop typing pulse, remove)
      const ctx = b.sessionId ? sessionContexts.get(b.sessionId) : null;
      if (ctx) {
        stopTypingPulse(ctx);
        sessionContexts.delete(b.sessionId);
        broadcastEvent?.('messenger.bridge.thread_cleaned', {
          type,
          threadId,
          sessionId: b.sessionId,
        });
      }
      if (b.sessionId) {
        const todoEntry = todoMessages.get(b.sessionId);
        if (todoEntry?.timer) clearTimeout(todoEntry.timer);
        todoMessages.delete(b.sessionId);
      }

      // Remove the store binding FIRST (before deleting the session) so the
      // session.deleted event we trigger below finds no binding and doesn't
      // loop back to delete the already-gone thread.
      bridgeStore.unbind({ type, botTokenHash: b.botTokenHash, targetKey: threadId });

      // Explicit deletion → delete the OpenCode session so it leaves the UI.
      if (reason === 'deleted' && b.sessionId) {
        sessionsBeingDeleted.add(b.sessionId);
        void opencodeAdapter
          .deleteSession(b.sessionId, b.projectPath ?? undefined)
          .catch(() => ({ ok: false }))
          .then((res) => {
            if (!res?.ok) {
              console.warn(`[BRIDGE] Could not delete OpenCode session ${b.sessionId} after thread delete`);
            }
            setTimeout(() => sessionsBeingDeleted.delete(b.sessionId), 30_000);
          });
      }
    }
  }

  /**
   * A session was deleted in the web UI (OpenCode `session.deleted` event) →
   * delete the bound Discord thread so the two stay in sync. Loop-safe: skips
   * sessions whose deletion the bridge itself initiated from a thread delete.
   */
  async function handleSessionDeleted(sessionId) {
    if (!sessionId || sessionsBeingDeleted.has(sessionId)) return;

    // Resolve the Discord surface: live context first, then the persistent
    // binding (survives restarts), then the reverse-lookup helper for token.
    const bindings = bridgeStore.lookupBySessionId(sessionId).filter((b) => b.type === 'discord' && b.targetKey);
    const ctx = sessionContexts.get(sessionId);
    if (ctx) {
      stopTypingPulse(ctx);
      sessionContexts.delete(sessionId);
    }
    const todoEntry = todoMessages.get(sessionId);
    if (todoEntry?.timer) clearTimeout(todoEntry.timer);
    todoMessages.delete(sessionId);
    if (bindings.length === 0) return;

    let token = ctx?.token ?? null;
    if (!token && typeof lookupMessengerTarget === 'function') {
      try {
        const target = await lookupMessengerTarget(sessionId);
        if (target?.token) token = target.token;
      } catch {
        // best-effort
      }
    }

    for (const b of bindings) {
      const threadId = String(b.targetKey);
      // Drop the binding first so the resulting THREAD_DELETE is a no-op.
      // findByTargetKey gives us the bot token hash each binding was stored
      // under (lookupBySessionId doesn't include it).
      try {
        for (const row of bridgeStore.findByTargetKey({ type: 'discord', targetKey: threadId })) {
          bridgeStore.unbind({ type: 'discord', botTokenHash: row.botTokenHash, targetKey: threadId });
        }
      } catch {
        // best-effort
      }
      if (token) {
        const res = await deleteDiscordThread({ token, threadId }).catch(() => ({ ok: false }));
        if (!res.ok) {
          console.warn(`[BRIDGE] Could not delete Discord thread ${threadId} after session delete`);
        } else {
          broadcastEvent?.('messenger.bridge.thread_deleted_from_session', { type: 'discord', threadId, sessionId });
        }
      }
    }
  }

  /**
   * The user's UI favourite models (Settings → favourite models), used by the
   * `/model` wizard's "⭐ Favourites" pseudo-provider. Returns an array of
   * `{ providerID, modelID }`; empty when none are configured or unavailable.
   */
  async function getFavoriteModels() {
    if (typeof readSettings !== 'function') return [];
    try {
      const settings = await readSettings();
      const list = Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : [];
      const out = [];
      const seen = new Set();
      for (const m of list) {
        const providerID = typeof m?.providerID === 'string' ? m.providerID.trim() : '';
        const modelID = typeof m?.modelID === 'string' ? m.modelID.trim() : '';
        if (!providerID || !modelID) continue;
        const key = `${providerID}/${modelID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ providerID, modelID });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * The user's UI hidden models (Settings → Providers → hide model). Read from
   * the SAME `settings.json` the web UI persists to, so the Discord `/model`
   * wizard hides exactly what the UI hides instead of listing every model the
   * provider exposes. Returns an array of `{ providerID, modelID }`.
   */
  async function getHiddenModels() {
    if (typeof readSettings !== 'function') return [];
    try {
      const settings = await readSettings();
      const list = Array.isArray(settings?.hiddenModels) ? settings.hiddenModels : [];
      const out = [];
      const seen = new Set();
      for (const m of list) {
        const providerID = typeof m?.providerID === 'string' ? m.providerID.trim() : '';
        const modelID = typeof m?.modelID === 'string' ? m.modelID.trim() : '';
        if (!providerID || !modelID) continue;
        const key = `${providerID}/${modelID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ providerID, modelID });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Resolve the effective model + thinking-effort (variant) for a surface, the
   * same way {@link routeInbound} does, so the `/model` wizard can show what's
   * currently in effect before the user changes it.
   */
  async function getSurfaceModelInfo({ type, token, channelId, threadId = null }) {
    let model = null;
    let variant = null;
    let source = null;
    let sessionId = null;
    let sessionProjectPath = null;
    try {
      const hash = tokenHash(token);
      const stableKey = targetKey({ type, channelId, threadId });
      const row = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey });
      let projectPath = row?.projectPath ?? null;
      let projectLabel = row?.projectLabel ?? null;
      sessionId = row?.sessionId || null;
      sessionProjectPath = row?.projectPath ?? null;
      if (row?.modelOverride) {
        model = row.modelOverride;
        variant = row.variantOverride ?? null;
        source = 'this conversation';
      }
      if ((!model || !sessionId) && stableKey !== String(channelId)) {
        const parent = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: String(channelId) });
        if (!model && parent?.modelOverride) {
          model = parent.modelOverride;
          variant = parent.variantOverride ?? null;
          source = 'this conversation';
        }
        if (!sessionId && parent?.sessionId) {
          sessionId = parent.sessionId;
          sessionProjectPath = parent.projectPath ?? sessionProjectPath;
        }
        if (!projectPath) {
          projectPath = parent?.projectPath ?? null;
          projectLabel = parent?.projectLabel ?? null;
        }
      }
      if (!model && projectPath) {
        const pd = bridgeStore.getProjectDefaults?.(projectPath);
        if (pd?.modelDefault) {
          model = pd.modelDefault;
          variant = pd.variantDefault ?? null;
          source = `project default (${projectLabel ?? projectPath})`;
        }
      }
    } catch {
      // best-effort
    }
    if (!model) {
      const globals = await resolveGlobalDefaults();
      if (globals.model) {
        model = globals.model;
        variant = globals.variant ?? null;
        source = 'OpenChamber default';
      }
    }
    // Nothing configured at any layer — show the concrete model the bound
    // session is actually running (OpenCode's own pick) instead of a vague
    // "OpenCode default". Read it from the live session, same source the
    // session-idle footer uses.
    if (!model && sessionId) {
      const live = await fetchSessionModel(sessionId, sessionProjectPath);
      if (live?.model) {
        model = live.model;
        variant = live.variant ?? null;
        source = 'session';
      }
    }
    return { model, variant, source };
  }

  /** `{ providerID, id|modelID, variant? }` → `{ model: 'provider/model', variant }`. */
  function toModelRef(src, modelIdKey) {
    if (!src || typeof src !== 'object') return null;
    const providerId = src.providerID ?? src.providerId ?? '';
    const modelId = src[modelIdKey] ?? '';
    if (!providerId || !modelId) return null;
    const variant = typeof src.variant === 'string' && src.variant.trim() ? src.variant.trim() : null;
    return { model: `${providerId}/${modelId}`, variant };
  }

  /**
   * Read the concrete model (and reasoning variant, when present) a session is
   * actually running. Tries the session object's `model` first, then falls back
   * to the latest assistant message's model (OpenCode 1.4+ nests it under
   * `model`, older builds carry flat `providerID`/`modelID`). Returns null when
   * the session has no model yet or the fetch fails.
   */
  async function fetchSessionModel(sessionId, projectPath) {
    if (!sessionId) return null;
    const dir = projectPath ? `?directory=${encodeURIComponent(projectPath)}` : '';
    try {
      const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}${dir}`);
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const ref = toModelRef(d?.model, 'id');
        if (ref) return ref;
      }
    } catch {
      // fall through to the message scan
    }
    try {
      const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/message${dir}`);
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const info = list[i]?.info ?? list[i];
        if (!info || info.role !== 'assistant') continue;
        const ref = toModelRef(info.model, 'id') ?? toModelRef(info, 'modelID');
        if (ref) return ref;
      }
    } catch {
      // best-effort
    }
    return null;
  }

  /**
   * Set the OpenChamber-wide default model + thinking-effort (Settings →
   * Defaults) — the "whole system" scope of the `/model` wizard. Writes the
   * same `defaultModel` / `defaultVariant` settings the web chat reads. Pass an
   * empty/null variant to clear the effort.
   */
  async function setGlobalDefaultModel({ model, variant = null }) {
    if (typeof persistSettings !== 'function') {
      return { ok: false, error: 'settings are read-only on this server' };
    }
    try {
      await persistSettings({ defaultModel: model ?? '', defaultVariant: variant ?? '' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? 'failed to save the default model' };
    }
  }

  /**
   * Persist a conversation-scoped model + thinking-effort choice (the `/model`
   * wizard applies to the current conversation). Pass `variant: null` to clear
   * the effort.
   */
  function setSurfaceModel({ type, token, channelId, threadId = null, model, variant = null }) {
    bridgeStore.setOverrides({
      type,
      botTokenHash: tokenHash(token),
      targetKey: targetKey({ type, channelId, threadId }),
      modelOverride: model ?? null,
      variantOverride: variant ?? null,
    });
  }

  /**
   * Replay the surface's last user prompt (used by the `/model` wizard's "Send
   * last message" button). Goes through {@link routeInbound} so the new model /
   * effort apply and any in-flight turn is superseded.
   */
  /**
   * Apply a just-changed preference (verbosity, permission mode) to the turn
   * that is streaming RIGHT NOW on a surface, instead of only the next one.
   *
   * `emitPart` already re-resolves verbosity live per part, but a mid-turn
   * increase (e.g. `normal` → `verbose`) is otherwise held back by the
   * one-shot thinking-marker dedup. Refreshing `ctx.verbosity` and clearing
   * `lastPostedMarker` lets the remainder of the active turn render at the new
   * level immediately. Best-effort and a no-op when nothing is streaming.
   */
  function applyPreferencesToActiveTurn({ type, token, channelId, threadId = null }) {
    try {
      const hash = tokenHash(token);
      const stableKey = targetKey({ type, channelId, threadId });
      let sessionId = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: stableKey })?.sessionId || null;
      if (!sessionId && stableKey !== String(channelId)) {
        sessionId = bridgeStore.lookup({ type, botTokenHash: hash, targetKey: String(channelId) })?.sessionId || null;
      }
      if (!sessionId) return;
      const ctx = sessionContexts.get(sessionId);
      if (!ctx) return;
      ctx.verbosity = resolveVerbosity({
        type: ctx.type,
        token: ctx.token,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
      });
      // Let a mid-turn verbosity increase re-post the thinking marker / expand
      // reasoning on the rest of the current turn.
      ctx.lastPostedMarker = null;
    } catch {
      // best-effort — preferences still apply on the next part / turn
    }
  }

  async function resendLastMessage({ type, token, channelId, threadId = null, from = null }) {
    const key = lastPromptKey({ type, token, channelId, threadId });
    const text = lastPromptBySurface.get(key) ?? null;
    if (!text) return { ok: false, error: 'no previous message to resend' };
    const result = await routeInbound({ type, token, channelId, threadId, text, from });
    return result?.ok
      ? { ok: true, text }
      : { ok: false, error: result?.error ?? 'send failed' };
  }

  return {
    routeInbound,
    runCommand,
    listSurfaceSkills,
    /** List configured OpenCode agents (for the Discord `/agent` picker). */
    listAgents: () => opencodeAdapter.listAgents(),
    fetchProviders,
    getFavoriteModels,
    getSurfaceModelInfo,
    setSurfaceModel,
    setGlobalDefaultModel,
    resendLastMessage,
    applyPreferencesToActiveTurn,
    getHiddenModels,
    statusSnapshot,
    isEnabled,
    ensureSubscribed,
    initApprovalListener,
    handleApprovalDecision,
    handleQuestionDecision,
    handleThreadDeleted,
    handleSessionDeleted,
    handleChannelDeleted,
    handleChannelRenamed,
    /** Mention-only mode — checked by the Discord listener. */
    getMentionMode,
    /** Whether a surface already has a session binding (mention mode skips bound threads). */
    hasSurfaceBinding,
    /** Test seam — exposed so tests can drive events without an SSE stream. */
    _handleGlobalEvent: handleGlobalEvent,
    /** Test seam — run one thread-title polling sweep. */
    _sweepThreadTitles: sweepThreadTitles,
    store: bridgeStore,
    /** Shared approval context map — exposed so listeners can inspect it */
    approvalContexts,
    /** Shared question context map — exposed so listeners can inspect it */
    questionContexts,
  };
}
