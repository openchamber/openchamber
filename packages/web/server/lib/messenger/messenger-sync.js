import crypto from 'node:crypto';
import express, { Router } from 'express';
import {
  createDiscordListenerRegistry,
  generateApprovalId,
} from './discord-listener.js';
import { createMessengerOpencodeBridge } from './messenger-opencode-bridge.js';
import { createDiscordAgentRouter } from './discord-agent-api.js';
import { parseVerbosityLevel, VERBOSITY_LEVELS } from './messenger-verbosity.js';
import { parsePermissionMode, PERMISSION_MODES } from './messenger-permissions.js';
import { bootstrapProject as bootstrapProjectFn } from '../projects/project-bootstrap.js';
import { renderPermissionContext, escapeMd } from './messenger-render.js';
import { discoverSkills } from '../opencode/skills.js';

/**
 * Messenger sync routes for Discord.
 * Handles project↔channel mapping, message format adaptation, and onboarding.
 */
/** Map a Discord HTTP failure into a short, human-friendly message. */
function friendlyDiscordError(status, rawText) {
  const trimmed = (rawText ?? '').slice(0, 300);
  if (status === 401) return 'Invalid bot token.';
  if (status === 403) {
    return 'Bot has no access — invite it to the server and grant View Channel + Send Messages permission.';
  }
  if (status === 404) return 'Not found. Double-check the ID (right-click → Copy ID in Discord).';
  if (status === 429) return 'Rate-limited by Discord. Wait a few seconds and retry.';
  return trimmed || `HTTP ${status}`;
}

const SYNC_PROJECT_DELAY_MS = 2_000;
const SYNC_THREAD_DELAY_MS = 2_500;
const SYNC_RETRY_MAX = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discord REST fetch with automatic backoff on HTTP 429. */
async function discordFetch(url, init, { maxRetries = SYNC_RETRY_MAX } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt >= maxRetries) {
      return resp;
    }
    const retryAfterHeader =
      resp.headers.get('retry-after') ?? resp.headers.get('x-ratelimit-reset-after');
    const retryAfterSec = Number(retryAfterHeader);
    const waitMs = Number.isFinite(retryAfterSec)
      ? Math.max(1_500, Math.ceil(retryAfterSec * 1_000))
      : 2_500 * (attempt + 1);
    await sleep(waitMs);
  }
  throw new Error('discordFetch: exhausted retries');
}

/**
 * Slugify a project label into a Discord channel name. Discord lowercases and
 * hyphenates channel names anyway, so we normalise here for find-by-name and
 * create parity. Kept identical to the inline slug used by `/discord/sync-projects`
 * so a project resolves to the same channel regardless of which path created it.
 */
function slugifyProjectLabel(label) {
  return (
    String(label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'project'
  );
}

/** Inverse of `slugifyProjectLabel` — best-effort human label from a channel name. */
function labelFromChannelName(name) {
  return (
    String(name ?? '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Project'
  );
}

/** Short, stable hash of a bot token — matches the bridge store key scheme. */
function discordTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

/**
 * Resolve the Discord messenger target (incl. the bot token) for a session from
 * its persisted bridge binding + on-disk settings. Used by the bridge as a
 * token fallback when a session has no live in-memory context (e.g. deleting an
 * idle session from the sidebar, or a gateway-bot session after a restart).
 *
 * `readSettings` is ASYNC (it reads + migrates settings from disk) and MUST be
 * awaited. A previous version called it without `await`, leaving `settings` as a
 * pending Promise whose `.discord` was always undefined — so the bot token was
 * never found and every token-fallback caller silently failed. The most visible
 * symptom: hard-deleting (shift-delete) an idle session never removed its
 * Discord thread, because `handleSessionDeleted` skips the thread delete when no
 * token can be resolved.
 *
 * Exported for testing.
 */
export async function resolveMessengerTarget({ store, readSettings, sessionId }) {
  if (!store || typeof readSettings !== 'function') return null;
  const bindings = store.lookupBySessionId(sessionId);
  if (!bindings || bindings.length === 0) return null;
  const binding = bindings[0];
  const settings = await readSettings();
  if (!settings) return null;
  if (binding.type === 'discord') {
    const discord = settings.discord || settings.discordConnections?.[0] || {};
    const token = discord.botToken;
    if (!token) return null;
    // targetKey is the thread id on Discord (or channel id for direct msgs).
    return {
      type: 'discord',
      token,
      targetKey: binding.targetKey,
      threadId: null, // targetKey is already the thread
      projectPath: binding.projectPath,
    };
  }
  return null;
}

export function createMessengerSyncRouter({
  broadcastEvent,
  // Optional plumbing for the OpenCode↔messenger bridge. When provided,
  // inbound messages routed through the listeners are forwarded to OpenCode
  // and the streaming response is mirrored back into the messenger.
  globalEventHub = null,
  buildOpenCodeUrl = null,
  getOpenCodeAuthHeaders = null,
  // Async () => Project[] — used by the bridge for automatic channel/topic
  // → project resolution by slug, so the user doesn't have to fill in a
  // Channel/Topic Mapping by hand.
  listProjects = null,
  // Hooks for the project bootstrap flow (clone / path / new) that the
  // bridge fires when a channel has no resolved project. The two hooks
  // wrap settings-runtime.js so this router stays free of disk I/O.
  readSettings = null,
  persistSettings = null,
  sanitizeProjects = null,
  // Base URL of this OpenChamber server (for agent-facing scheduling docs).
  getLocalApiBaseUrl = null,
  // OpenChamber's per-project scheduler — the Discord /schedule command and
  // the agent-facing scheduling instructions create tasks THERE so they sync
  // with the web UI's Scheduled-tasks dialog.
  projectConfigRuntime = null,
  scheduledTasksRuntime = null,
  // Optional async hook that starts the shared global event stream (the
  // OpenCode watcher + hub). The bridge depends on hub events for mirroring,
  // questions, todos and permissions — without this, a headless server that
  // never had a browser client connected would silently mirror nothing.
  ensureEventStream = null,
}) {
  const router = Router();

  router.use(express.json({ limit: '256kb' }));

  const projectBootstrap =
    readSettings && persistSettings && sanitizeProjects
      ? (params) =>
          bootstrapProjectFn({
            ...params,
            readSettings,
            persistSettings,
            sanitizeProjects,
          })
      : null;

  // Lookup a messenger surface by session ID.
  // Used by the bridge's permission.asked handler when the session is
  // not tracked locally (e.g. inbound came through the gateway bot).
  const makeLookupMessengerTarget = () => {
    // We need the bridgeStore reference, which is created inside the bridge.
    // Return a function that the bridge can call after initialization.
    let resolved = null;
    return async (sessionId) => {
      // Resolve lazily after bridge is created
      if (!resolved && bridge?.store) {
        resolved = { store: bridge.store, readSettings };
      }
      if (!resolved || !resolved.readSettings) return null;
      try {
        return await resolveMessengerTarget({
          store: resolved.store,
          readSettings: resolved.readSettings,
          sessionId,
        });
      } catch {
        // lookup failed — return null
        return null;
      }
    };
  };

  /**
   * Find the Discord channel a project's web conversations should mirror into.
   * Resolution order:
   *   1. persisted per-project binding (settings.discord.projectBindings) — the
   *      authoritative project→channel map the Settings UI sends at start.
   *   2. a channel binding recorded in the bridge store for this project path.
   *   3. null (caller falls back to the guild/default channel).
   * Returns { channelId, projectLabel } or null.
   */
  function resolveProjectChannel({ discord, projectPath }) {
    if (!projectPath) return null;
    const bindings = Array.isArray(discord?.projectBindings) ? discord.projectBindings : [];
    const match = bindings.find(
      (b) => b && b.channelId && b.projectPath && b.projectPath === projectPath,
    );
    if (match?.channelId) {
      return { channelId: String(match.channelId), projectLabel: match.projectLabel ?? null };
    }
    // Fallback: the bridge store may already hold a channel↔project binding
    // (e.g. created by /bridge/project-added). Pick the most-recently-used one.
    try {
      if (bridge?.store?.list) {
        const rows = bridge.store
          .list({ type: 'discord' })
          .filter((r) => r.projectPath === projectPath && r.targetKey && r.sessionId === '');
        if (rows[0]?.targetKey) {
          return { channelId: String(rows[0].targetKey), projectLabel: rows[0].projectLabel ?? null };
        }
      }
    } catch {
      // best-effort
    }
    return null;
  }

  /**
   * Build the channel→project resolver the Discord listener uses to route an
   * inbound message to the right OpenChamber project. Keyed by the persisted
   * `projectBindings` (channel id → project). Shared by the manual
   * `/discord/listener/start` path and the boot-time `/discord/auto-start`
   * path so they can never drift — auto-start previously passed NO bindings,
   * which made every channel fall back to the first project on the server.
   */
  function buildResolveProject(projectBindings) {
    const bindingMap = new Map(
      Array.isArray(projectBindings)
        ? projectBindings
            .filter((b) => b && b.channelId)
            .map((b) => [
              String(b.channelId),
              { path: b.projectPath ?? null, label: b.projectLabel ?? null },
            ])
        : [],
    );
    return ({ channelId }) => bindingMap.get(String(channelId)) ?? null;
  }

  async function resolveDefaultDiscordTarget({ projectPath } = {}) {
    if (!readSettings) return null;
    let settings;
    try {
      settings = await readSettings();
    } catch {
      return null;
    }
    const discord = settings?.discord;
    const token = discord?.botToken;
    if (!token) return null;

    // The configured Discord owner is auto-added to web-created threads so the
    // thread shows up under the channel for them (a bot-only thread is hidden).
    const userId =
      typeof discord.defaultUserId === 'string' && discord.defaultUserId.trim().length > 0
        ? discord.defaultUserId.trim()
        : null;

    // Prefer the project's own channel so web conversations land in the right
    // place (and in a per-session thread) instead of dumping into #general.
    const projectChannel = resolveProjectChannel({ discord, projectPath });
    if (projectChannel?.channelId) {
      return {
        type: 'discord',
        token,
        channelId: projectChannel.channelId,
        threadId: null,
        projectPath: projectPath ?? null,
        projectLabel: projectChannel.projectLabel ?? null,
        userId,
      };
    }

    let channelId = discord.defaultChannelId || null;
    if (!channelId && discord.guildId) {
      try {
        const resp = await fetch(
          `https://discord.com/api/v10/guilds/${encodeURIComponent(discord.guildId)}/channels`,
          { headers: { Authorization: `Bot ${token}` } },
        );
        if (resp.ok) {
          const channels = await resp.json();
          const candidate = Array.isArray(channels)
            ? channels
                .filter((ch) => [0, 5, 15].includes(ch?.type))
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
            : null;
          channelId = candidate?.id ?? null;
          if (channelId && persistSettings) {
            await persistSettings({
              discord: {
                ...discord,
                defaultChannelId: channelId,
              },
            }).catch(() => {});
          }
        }
      } catch {
        // best-effort fallback; without a channel there is no default target
      }
    }

    if (!channelId) return null;
    return {
      type: 'discord',
      token,
      channelId,
      threadId: null,
      projectPath: projectPath ?? null,
      projectLabel: null,
      userId,
    };
  }

  const opencodeFetch = buildOpenCodeUrl
    ? async (path, init = {}) => {
        const url = buildOpenCodeUrl(path, '');
        const headers = {
          Accept: 'application/json',
          ...(getOpenCodeAuthHeaders?.() ?? {}),
          ...(init.headers ?? {}),
        };
        return fetch(url, { ...init, headers });
      }
    : null;

  const bridge =
    globalEventHub && buildOpenCodeUrl
      ? createMessengerOpencodeBridge({
          globalEventHub,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
          broadcastEvent,
          listProjects,
          bootstrapProject: projectBootstrap,
          lookupMessengerTarget: makeLookupMessengerTarget(),
          getDefaultMessengerTarget: readSettings ? resolveDefaultDiscordTarget : null,
          // Settings access for voice-message STT (sttServerUrl/sttModel/sttLanguage).
          readSettings,
          // Lets the bridge keep settings.discord.projectBindings in sync when a
          // Discord channel that maps to a project is renamed/deleted in Discord
          // (the two-way half of project↔channel sync).
          persistSettings,
          getLocalApiBaseUrl,
          projectConfigRuntime,
          scheduledTasksRuntime,
          // Powers the Discord `/skill` picker — list skills available to the
          // agent in the surface's bound project (or user-level when unbound).
          listSkills: ({ projectPath } = {}) => {
            try {
              return discoverSkills(projectPath || undefined);
            } catch {
              return [];
            }
          },
          // Fall back to the same Settings → Defaults model/agent the web chat
          // uses when a surface/project hasn't set its own override.
          getGlobalDefaults: readSettings
            ? async () => {
                try {
                  const settings = await readSettings();
                  return {
                    model: settings?.defaultModel ?? null,
                    agent: settings?.defaultAgent ?? null,
                    variant: settings?.defaultVariant ?? null,
                  };
                } catch {
                  return { model: null, agent: null };
                }
              }
            : null,
          resolveProjectChannel: readSettings
            ? ({ discord, projectPath }) => resolveProjectChannel({ discord, projectPath })
            : null,
        })
      : null;
  if (bridge) {
    try {
      bridge.ensureSubscribed();
    } catch {
      // ignore — subscription only fails when the hub itself is unavailable
    }

    // Wire approval button clicks back to OpenCode's permission.reply API.
    // OpenCode SDK endpoint: POST /permission/{requestID}/reply
    // Body: { reply: "once" | "always" | "reject" }
    // Query: ?directory=... (directory is a query param, NOT in body)
    try {
      bridge.initApprovalListener?.(async ({ sessionID, requestID, reply, directory }) => {
        if (!sessionID || !requestID) return;
        const requestIdEnc = encodeURIComponent(requestID);
        const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const url = buildOpenCodeUrl(`/permission/${requestIdEnc}/reply${dirParam}`, '');
        const headers = {
          'Content-Type': 'application/json',
          ...(getOpenCodeAuthHeaders?.() ?? {}),
        };
        console.log('[MESSENGER] Sending permission reply to OpenCode:', {
          url,
          reply,
          sessionID,
          requestID,
          directory,
        });
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reply }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(
            '[MESSENGER] OpenCode permission reply failed:',
            res.status,
            errBody.slice(0, 300),
            { sessionID, requestID, reply, directory },
          );
        } else {
          console.log('[MESSENGER] OpenCode permission reply succeeded:', { sessionID, requestID, reply });
        }
      });
    } catch (err) {
      console.error('[MESSENGER] Failed to init approval listener:', err?.message ?? err);
    }
  }

  const discordListener = createDiscordListenerRegistry({ broadcastEvent, bridge });

  // Agent-facing Discord API — a high-level surface (resolve a project/session
  // to its Discord URL, post a message there, create a new project + channel)
  // designed to be delegated to an AI agent. The bot token is resolved
  // server-side from settings so the agent never handles the secret.
  router.use(
    '/agent',
    createDiscordAgentRouter({
      readSettings,
      bridge,
      broadcastEvent,
      getLocalApiBaseUrl,
      listProjects,
      opencodeFetch,
      bootstrapProject: projectBootstrap,
      // Resolve the bot config server-side and reuse the exact same
      // find-or-create channel flow the UI's project-add path uses, so an
      // agent-created project lands in Discord identically to a UI-added one.
      autoCreateProjectChannel: async (project) => {
        const { discord } = await loadDiscordSettings();
        if (!discord?.botToken || !discord?.guildId) return null;
        return autoCreateMessengerSurfacesForProject(project, {
          discord: {
            token: discord.botToken,
            guildId: discord.guildId,
            parentCategoryId: discord.parentCategoryId ?? null,
          },
        });
      },
    }),
  );

  // Messenger configuration
  router.get('/config', (_req, res) => {
    res.json({
      supportedMessengers: ['discord'],
      discord: {
        features: ['channels', 'threads', 'embeds', 'reactions', 'files'],
        maxMessageLength: 2000,
        formatting: 'markdown-discord',
      },
    });
  });

  // Test connection endpoint
  router.post('/test', async (req, res) => {
    const { type, token } = req.body ?? {};

    if (!type || !token) {
      return res.status(400).json({ error: 'type and token required' });
    }

    try {
      if (type === 'discord') {
        const headers = { Authorization: `Bot ${token}` };
        const resp = await fetch('https://discord.com/api/v10/users/@me', { headers });
        if (!resp.ok) {
          const text = await resp.text();
          return res.json({
            ok: false,
            error: `Discord: ${resp.status} — ${friendlyDiscordError(resp.status, text)}`,
          });
        }
        const data = await resp.json();

        // Fetch guilds the bot belongs to so the UI can show server context.
        // Failure here should not break verify — keep the response best-effort.
        let guilds = [];
        try {
          const gResp = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers });
          if (gResp.ok) {
            const list = await gResp.json();
            guilds = Array.isArray(list)
              ? list.slice(0, 25).map((g) => ({ id: g.id, name: g.name }))
              : [];
          }
        } catch {
          // ignore — guilds is optional
        }

        return res.json({
          ok: true,
          id: data.id,
          username: data.username,
          discriminator: data.discriminator,
          guilds,
        });
      }

      return res.status(400).json({ error: `Unknown messenger type: ${type}` });
    } catch (err) {
      return res.json({ ok: false, error: err.message ?? 'Connection failed' });
    }
  });

  /**
   * Send a real message to a Discord channel.
   * Body: { type: 'discord', token, target, text }
   *   - target: channel_id
   */
  router.post('/send', async (req, res) => {
    const { type, token, target, text } = req.body ?? {};

    if (!type || !token || !target || !text) {
      return res.status(400).json({ error: 'type, token, target and text are required' });
    }

    try {
      if (type === 'discord') {
        const resp = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(target)}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: String(text).slice(0, 2000) }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return res.json({
            ok: false,
            error: `Discord: ${resp.status} — ${friendlyDiscordError(resp.status, errText)}`,
          });
        }
        const data = await resp.json();
        broadcastEvent?.('messenger.discord.sent', { target, messageId: data.id });
        return res.json({ ok: true, messageId: data.id, sentAt: new Date().toISOString() });
      }

      return res.status(400).json({ error: `Unknown messenger type: ${type}` });
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'Send failed' });
    }
  });

  /**
   * Resolve a Discord channel by id and (best-effort) its guild name.
   * Body: { token, channelId }
   * Returns: { ok, channelId, channelName, channelType, guildId, guildName, parentId, canSend }
   *
   * channelType numeric mapping (Discord): 0=text, 5=announcement, 11=public_thread,
   * 12=private_thread, 15=forum, 16=media, 2=voice — we just expose the raw int + a label.
   */
  router.post('/discord/resolve-channel', async (req, res) => {
    const { token, channelId } = req.body ?? {};
    if (!token || !channelId) {
      return res.status(400).json({ error: 'token and channelId required' });
    }
    const headers = { Authorization: `Bot ${token}` };
    try {
      const chResp = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
        { headers },
      );
      if (!chResp.ok) {
        const text = await chResp.text();
        return res.json({
          ok: false,
          error: `Discord: ${chResp.status} — ${friendlyDiscordError(chResp.status, text)}`,
        });
      }
      const ch = await chResp.json();

      // Best-effort fetch of guild name for nicer UX. The bot only sees guilds it joined.
      let guildName = null;
      if (ch.guild_id) {
        try {
          const gResp = await fetch(
            `https://discord.com/api/v10/guilds/${encodeURIComponent(ch.guild_id)}`,
            { headers },
          );
          if (gResp.ok) {
            const g = await gResp.json();
            guildName = g?.name ?? null;
          }
        } catch {
          // ignore
        }
      }

      const typeLabels = {
        0: 'text',
        2: 'voice',
        4: 'category',
        5: 'announcement',
        10: 'announcement-thread',
        11: 'public-thread',
        12: 'private-thread',
        13: 'stage',
        15: 'forum',
        16: 'media',
      };

      return res.json({
        ok: true,
        channelId: ch.id,
        channelName: ch.name ?? null,
        channelType: ch.type,
        channelTypeLabel: typeLabels[ch.type] ?? `type-${ch.type}`,
        guildId: ch.guild_id ?? null,
        guildName,
        parentId: ch.parent_id ?? null,
      });
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'resolve-channel failed' });
    }
  });

  /**
   * Resolve a Discord guild (server) by id and return its channel + thread
   * topology so the UI can show "12 channels · 3 categories · 4 active threads"
   * and the user can pick a parent category for per-project channels.
   *
   * Body: { token, guildId }
   * Returns: { ok, id, name, iconHash, channels, categories, activeThreads, defaultChannelId }
   *   - channels[]:   text/announcement/forum channels (type 0/5/15) suitable for posting
   *   - categories[]: channel.type === 4
   *   - activeThreads[]: from /guilds/{id}/threads/active
   *   - defaultChannelId: first text channel id (used for test messages when nothing is set)
   */
  router.post('/discord/resolve-guild', async (req, res) => {
    const { token, guildId } = req.body ?? {};
    if (!token || !guildId) {
      return res.status(400).json({ error: 'token and guildId required' });
    }
    const headers = { Authorization: `Bot ${token}` };
    try {
      const gResp = await fetch(
        `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`,
        { headers },
      );
      if (!gResp.ok) {
        const text = await gResp.text();
        return res.json({
          ok: false,
          error: `Discord: ${gResp.status} — ${friendlyDiscordError(gResp.status, text)}`,
        });
      }
      const guild = await gResp.json();

      let rawChannels = [];
      try {
        const chResp = await fetch(
          `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
          { headers },
        );
        if (chResp.ok) {
          rawChannels = await chResp.json();
        }
      } catch {
        // ignore — channels best-effort
      }

      let activeThreads = [];
      try {
        const thResp = await fetch(
          `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/threads/active`,
          { headers },
        );
        if (thResp.ok) {
          const thData = await thResp.json();
          activeThreads = Array.isArray(thData?.threads)
            ? thData.threads.map((t) => ({
                id: t.id,
                name: t.name,
                parentId: t.parent_id ?? null,
                type: t.type,
                archived: Boolean(t.thread_metadata?.archived),
              }))
            : [];
        }
      } catch {
        // ignore — threads best-effort
      }

      const channels = rawChannels
        .filter((c) => [0, 5, 15].includes(c.type))
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parent_id ?? null,
          position: c.position,
        }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const categories = rawChannels
        .filter((c) => c.type === 4)
        .map((c) => ({ id: c.id, name: c.name, position: c.position }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

      return res.json({
        ok: true,
        id: guild.id,
        name: guild.name,
        iconHash: guild.icon ?? null,
        channels,
        categories,
        activeThreads,
        defaultChannelId: channels[0]?.id ?? null,
      });
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'resolve-guild failed' });
    }
  });

  /**
   * Per-project Discord sync. For each project we find-or-create a text channel
   * under an optional parent category, post a status message, and (optionally)
   * spawn a thread from that message named "OpenChamber agent sync — {date}" so details
   * stay out of the main channel feed.
   *
   * Body: {
   *   token, guildId,
   *   parentCategoryId?: string,
   *   summary?: string,
   *   projects: [{ id, label, body }],
   *   mappings: ProjectMessengerMapping[],
   *   createThreads?: boolean,
   * }
   *
   * Returns: {
   *   ok,
   *   guildId,
   *   summaryMessageId?,
   *   channels: [{
   *     projectId, projectLabel,
   *     channelId, channelName,
   *     messageId,
   *     threadId, threadName,
   *     created,             // true = channel was just created
   *     threadCreated,
   *     error,
   *   }],
   * }
   */
  router.post('/discord/sync-projects', async (req, res) => {
    const { token, guildId, parentCategoryId, summary, projects, mappings, createThreads } =
      req.body ?? {};
    if (!token || !guildId) {
      return res.status(400).json({ error: 'token and guildId required' });
    }
    const headers = {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    };
    const projectList = Array.isArray(projects) ? projects : [];
    const mappingByProject = new Map(
      (Array.isArray(mappings) ? mappings : [])
        .filter((m) => m && m.projectId)
        .map((m) => [m.projectId, m]),
    );

    const slugify = (s) =>
      String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 90) || 'project';

    // Fetch existing channels so we can do find-by-name before creating.
    let existingChannels = [];
    try {
      const cResp = await fetch(
        `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
        { headers: { Authorization: `Bot ${token}` } },
      );
      if (cResp.ok) {
        existingChannels = await cResp.json();
      } else {
        const text = await cResp.text();
        return res.json({
          ok: false,
          error: `Discord: ${cResp.status} — ${friendlyDiscordError(cResp.status, text)}`,
        });
      }
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'failed to list channels' });
    }

    const existingByName = new Map(
      existingChannels
        .filter((c) => c.type === 0 || c.type === 5)
        .map((c) => [String(c.name).toLowerCase(), c]),
    );
    const existingById = new Map(existingChannels.map((c) => [c.id, c]));

    // Optional top-level summary message in the first text channel of the
    // parent category (or first text channel of the guild if no category).
    let summaryMessageId = null;
    if (summary && summary.trim().length > 0) {
      const candidate = parentCategoryId
        ? existingChannels.find(
            (c) => (c.type === 0 || c.type === 5) && c.parent_id === parentCategoryId,
          )
        : existingChannels.find((c) => c.type === 0 || c.type === 5);
      if (candidate) {
        try {
          const sResp = await fetch(
            `https://discord.com/api/v10/channels/${encodeURIComponent(candidate.id)}/messages`,
            { method: 'POST', headers, body: JSON.stringify({ content: String(summary).slice(0, 2000) }) },
          );
          if (sResp.ok) {
            const sJson = await sResp.json();
            summaryMessageId = sJson.id ?? null;
          }
        } catch {
          // ignore — summary is best-effort
        }
      }
    }

    const settingsProjectPathById = new Map();
    if (readSettings) {
      try {
        const settings = await readSettings();
        for (const project of Array.isArray(settings?.projects) ? settings.projects : []) {
          if (project?.id && project?.path) settingsProjectPathById.set(String(project.id), String(project.path));
        }
      } catch {
        // best-effort; newer clients send project.path in the sync payload
      }
    }

    const channelResults = [];

    for (let projectIndex = 0; projectIndex < projectList.length; projectIndex++) {
      const project = projectList[projectIndex];
      if (projectIndex > 0) {
        await sleep(SYNC_PROJECT_DELAY_MS);
      }
      const label = project.label || `Project ${project.id}`;
      const desiredSlug = slugify(label);
      let channel = null;
      let created = false;
      let entryError = null;

      // 1) Try the stored mapping channel id first
      const stored = mappingByProject.get(project.id)?.discord;
      if (stored?.channelId && existingById.has(stored.channelId)) {
        channel = existingById.get(stored.channelId);
      }
      // 2) Then try find-by-name (case-insensitive)
      if (!channel) {
        channel = existingByName.get(desiredSlug) ?? null;
      }
      // 3) Otherwise create it
      if (!channel) {
        try {
          const cResp = await discordFetch(
            `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                name: desiredSlug,
                type: 0, // GUILD_TEXT
                parent_id: parentCategoryId || null,
                topic: `OpenChamber agent sync channel for project ${label}`.slice(0, 1024),
              }),
            },
          );
          if (cResp.ok) {
            channel = await cResp.json();
            created = true;
            existingById.set(channel.id, channel);
            existingByName.set(String(channel.name).toLowerCase(), channel);
          } else {
            const text = await cResp.text();
            entryError = `Discord: ${cResp.status} — ${friendlyDiscordError(cResp.status, text)}`;
          }
        } catch (err) {
          entryError = err?.message ?? 'create channel failed';
        }
      }

      let messageId = null;
      let threadId = null;
      let threadName = null;
      let threadCreated = false;
      let threadError = null;

      if (channel && !entryError) {
        // Post the per-project status message.
        try {
          const mResp = await discordFetch(
            `https://discord.com/api/v10/channels/${encodeURIComponent(channel.id)}/messages`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                content: String(project.body ?? `OpenChamber agent sync update for ${label}`).slice(0, 2000),
              }),
            },
          );
          if (mResp.ok) {
            const mJson = await mResp.json();
            messageId = mJson.id ?? null;
          } else {
            const text = await mResp.text();
            entryError = `Discord: ${mResp.status} — ${friendlyDiscordError(mResp.status, text)}`;
          }
        } catch (err) {
          entryError = err?.message ?? 'send message failed';
        }

        // Optional: start a thread from that message so details stay out of
        // the main channel feed. We keep thread errors SEPARATE from
        // entryError so the row can render "channel ✓ message ✓ thread ✗"
        // instead of dropping the whole project on the floor.
        if (!entryError && messageId && createThreads !== false) {
          threadName = `OpenChamber agent sync — ${new Date().toISOString().slice(0, 10)}`;
          await sleep(SYNC_THREAD_DELAY_MS);
          try {
            const tResp = await discordFetch(
              `https://discord.com/api/v10/channels/${encodeURIComponent(channel.id)}/messages/${messageId}/threads`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  name: threadName.slice(0, 100),
                  auto_archive_duration: 1440, // 1 day
                }),
              },
            );
            if (tResp.ok) {
              const tJson = await tResp.json();
              threadId = tJson.id ?? null;
              threadCreated = true;
            } else {
              const text = await tResp.text();
              const hint =
                tResp.status === 403
                  ? 'Bot lacks Create Public Threads + Send Messages in Threads on this channel. ' +
                    'Either grant the bot Administrator or check the channel-level permission overrides ' +
                    '(server-level Administrator can still be overridden per-channel).'
                  : tResp.status === 400
                    ? "Discord rejected the thread creation — common causes: 'auto_archive_duration' " +
                      'not allowed for this server tier, channel is a forum/announcement type that ' +
                      "doesn't accept message-threads, or the channel was just created and isn't fully " +
                      'visible yet (retry once).'
                    : friendlyDiscordError(tResp.status, text);
              threadError = `Discord: ${tResp.status} — ${hint}`;
            }
          } catch (err) {
            threadError = err?.message ?? 'thread create failed';
          }
        }
      }

      const projectPath =
        typeof project.path === 'string' && project.path
          ? project.path
          : settingsProjectPathById.get(String(project.id)) ?? null;

      channelResults.push({
        projectId: project.id,
        projectPath,
        projectLabel: label,
        channelId: channel?.id ?? null,
        channelName: channel?.name ?? null,
        messageId,
        threadId,
        threadName,
        created,
        threadCreated,
        threadRequested: createThreads !== false,
        error: entryError,
        threadError,
      });
    }

    // Second pass: retry thread creation for rows that only failed due to rate limits.
    for (const row of channelResults) {
      if (row.threadCreated || !row.threadError || !String(row.threadError).includes('429')) {
        continue;
      }
      if (!row.channelId || !row.messageId || createThreads === false) {
        continue;
      }
      const retryThreadName =
        row.threadName ?? `OpenChamber agent sync — ${new Date().toISOString().slice(0, 10)}`;
      await sleep(SYNC_THREAD_DELAY_MS * 2);
      try {
        const tResp = await discordFetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(row.channelId)}/messages/${row.messageId}/threads`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: retryThreadName.slice(0, 100),
              auto_archive_duration: 1440,
            }),
          },
        );
        if (tResp.ok) {
          const tJson = await tResp.json();
          row.threadId = tJson.id ?? null;
          row.threadName = retryThreadName;
          row.threadCreated = true;
          row.threadError = null;
        }
      } catch (err) {
        row.threadError = err?.message ?? row.threadError;
      }
    }

    if (persistSettings) {
      const projectBindings = channelResults
        .filter((c) => c.channelId && c.projectPath && !c.error)
        .map((c) => ({
          channelId: String(c.channelId),
          projectPath: String(c.projectPath),
          projectLabel: c.projectLabel ? String(c.projectLabel) : undefined,
        }));
      if (projectBindings.length > 0) {
        try {
          const current = readSettings ? await readSettings() : null;
          const prev = current?.discord ?? {};
          await persistSettings({
            discord: {
              ...prev,
              botToken: token || prev.botToken || undefined,
              guildId: guildId || prev.guildId || undefined,
              defaultChannelId: prev.defaultChannelId || undefined,
              projectBindings,
            },
          });
        } catch {
          // best-effort — sync succeeded, but settings persistence failed
        }
      }
    }

    broadcastEvent?.('messenger.discord.synced', {
      guildId,
      projectCount: projectList.length,
      created: channelResults.filter((c) => c.created).length,
      errors: channelResults.filter((c) => c.error).length,
    });

    res.json({
      ok: channelResults.every((c) => !c.error),
      guildId,
      summaryMessageId,
      channels: channelResults,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Discord Gateway listener
  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot of the OpenCode bridge — list of channel↔session bindings and
  // any prompts currently in flight. Useful for the settings UI to show
  // "Discord channel X is bound to session Y".
  router.post('/bridge/status', (req, res) => {
    if (!bridge) {
      return res.json({
        ok: true,
        enabled: false,
        bindings: [],
        active: [],
        verbosity: {},
        permissionMode: {},
      });
    }
    const { type, token } = req.body ?? {};
    const verbosity = {
      discord: bridge.store.getVerbosityDefault?.('discord') ?? null,
    };
    const permissionMode = {
      discord: bridge.store.getPermissionModeDefault?.('discord') ?? null,
    };
    return res.json({
      ok: true,
      enabled: true,
      verbosity,
      permissionMode,
      ...bridge.statusSnapshot({ type, token }),
    });
  });

  /**
   * Per-messenger default verbosity (`quiet` | `normal` | `verbose`). This is
   * the same value the in-chat `/verbosity default <level>` command writes, so
   * the OpenChamber UI and Discord stay in sync. A per-conversation
   * `/verbosity <level>` override always wins over this default.
   *
   * POST body: { type: 'discord', level }  (level null clears it)
   * GET query: ?type=discord
   */
  router.post('/bridge/verbosity', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const { type, level } = req.body ?? {};
    if (type !== 'discord') {
      return res.status(400).json({ ok: false, error: "type must be 'discord'" });
    }
    if (level == null || level === '') {
      bridge.store.setVerbosityDefault(type, null);
      return res.json({ ok: true, type, level: null });
    }
    const parsed = parseVerbosityLevel(level);
    if (!parsed) {
      return res
        .status(400)
        .json({ ok: false, error: `level must be one of: ${VERBOSITY_LEVELS.join(', ')}` });
    }
    bridge.store.setVerbosityDefault(type, parsed);
    return res.json({ ok: true, type, level: parsed });
  });

  router.get('/bridge/verbosity', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const type = typeof req.query?.type === 'string' ? req.query.type : '';
    if (type === 'discord') {
      return res.json({ ok: true, type, level: bridge.store.getVerbosityDefault?.(type) ?? null });
    }
    return res.json({
      ok: true,
      levels: VERBOSITY_LEVELS,
      verbosity: {
        discord: bridge.store.getVerbosityDefault?.('discord') ?? null,
      },
    });
  });

  /**
   * Per-messenger default tool permission mode (`ask` | `auto-edit` | `yolo`).
   * Same value as `/yolo default <mode>` / `/permissions default <mode>`, so
   * the OpenChamber UI and Discord stay in sync. A per-conversation
   * `/permissions <mode>` override always wins over this default.
   *
   * POST body: { type: 'discord', mode }  (mode null clears it)
   * GET query: ?type=discord
   */
  router.post('/bridge/permission-mode', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const { type, mode } = req.body ?? {};
    if (type !== 'discord') {
      return res.status(400).json({ ok: false, error: "type must be 'discord'" });
    }
    if (mode == null || mode === '') {
      bridge.store.setPermissionModeDefault(type, null);
      return res.json({ ok: true, type, mode: null });
    }
    const parsed = parsePermissionMode(mode);
    if (!parsed) {
      return res
        .status(400)
        .json({ ok: false, error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` });
    }
    bridge.store.setPermissionModeDefault(type, parsed);
    return res.json({ ok: true, type, mode: parsed });
  });

  router.get('/bridge/permission-mode', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const type = typeof req.query?.type === 'string' ? req.query.type : '';
    if (type === 'discord') {
      return res.json({
        ok: true,
        type,
        mode: bridge.store.getPermissionModeDefault?.(type) ?? null,
      });
    }
    return res.json({
      ok: true,
      modes: PERMISSION_MODES,
      permissionMode: {
        discord: bridge.store.getPermissionModeDefault?.('discord') ?? null,
      },
    });
  });

  /**
   * Read the persisted Discord block + its project→channel bindings array.
   * Always returns a usable shape, even when settings access is unavailable.
   */
  async function loadDiscordSettings() {
    if (!readSettings) return { discord: {}, bindings: [] };
    try {
      const settings = await readSettings();
      const discord = settings?.discord ?? {};
      const bindings = Array.isArray(discord.projectBindings) ? discord.projectBindings : [];
      return { discord, bindings };
    } catch {
      return { discord: {}, bindings: [] };
    }
  }

  /**
   * Persist a fresh project→channel binding list, preserving the rest of the
   * Discord block. Filters to valid entries and drops the key entirely when the
   * list is empty so settings stay clean. Best-effort.
   */
  async function saveProjectBindings(nextBindings, discord) {
    if (!persistSettings) return;
    const normalized = (Array.isArray(nextBindings) ? nextBindings : [])
      .filter((b) => b && b.channelId && b.projectPath)
      .map((b) => ({
        channelId: String(b.channelId),
        projectPath: String(b.projectPath),
        projectLabel: b.projectLabel ? String(b.projectLabel) : undefined,
      }));
    try {
      await persistSettings({
        discord: {
          ...discord,
          projectBindings: normalized.length > 0 ? normalized : undefined,
        },
      });
    } catch {
      // best-effort — a failed persist must not break the API response
    }
  }

  /** Upsert a project→channel binding by project path. */
  function upsertBinding(bindings, { channelId, projectPath, projectLabel }) {
    const next = bindings.filter(
      (b) => b && b.projectPath !== projectPath && String(b.channelId) !== String(channelId),
    );
    next.push({ channelId: String(channelId), projectPath, projectLabel });
    return next;
  }

  /**
   * Find-or-create the Discord text channel that mirrors a project, persist the
   * project→channel binding, and pre-bind it in the bridge store so the first
   * web/Discord message lands in the project's own channel instead of #general.
   *
   * Idempotent: an existing binding or a channel matching the project slug is
   * reused rather than duplicated. Best-effort — failures are reported but never
   * throw, so the UI project-add flow is never blocked.
   */
  async function autoCreateMessengerSurfacesForProject(project, opts = {}) {
    const results = [];
    if (!project || !project.path) return results;
    const projectLabel = project.label ?? project.path.split('/').pop() ?? project.path;
    const slug = slugifyProjectLabel(projectLabel);

    const discord = opts.discord ?? null;
    if (discord?.token && discord?.guildId) {
      const headers = {
        Authorization: `Bot ${discord.token}`,
        'Content-Type': 'application/json',
      };
      const { discord: discordSettings, bindings } = await loadDiscordSettings();
      const existingBinding = bindings.find(
        (b) => b && b.channelId && b.projectPath === project.path,
      );

      let channelId = null;
      let channelName = null;
      let created = false;
      let error = null;

      // 1) Reuse an existing channel: the persisted binding's channel if it
      //    still exists, otherwise a text channel whose name matches the slug.
      try {
        const listResp = await fetch(
          `https://discord.com/api/v10/guilds/${encodeURIComponent(discord.guildId)}/channels`,
          { headers: { Authorization: `Bot ${discord.token}` } },
        );
        if (listResp.ok) {
          const channels = await listResp.json();
          const list = Array.isArray(channels) ? channels : [];
          const byId = existingBinding
            ? list.find((c) => String(c.id) === String(existingBinding.channelId))
            : null;
          const byName = list.find(
            (c) => (c.type === 0 || c.type === 5) && String(c.name).toLowerCase() === slug,
          );
          const match = byId ?? byName ?? null;
          if (match) {
            channelId = match.id;
            channelName = match.name;
          }
        }
      } catch {
        // best-effort — fall through to create
      }

      // 2) Create the channel when nothing usable exists yet.
      if (!channelId) {
        try {
          const cResp = await fetch(
            `https://discord.com/api/v10/guilds/${encodeURIComponent(discord.guildId)}/channels`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                name: slug,
                type: 0,
                parent_id: discord.parentCategoryId ?? null,
                topic: `OpenChamber agent sync channel for ${projectLabel}`.slice(0, 1024),
              }),
            },
          );
          if (cResp.ok) {
            const data = await cResp.json();
            channelId = data.id;
            channelName = data.name;
            created = true;
          } else {
            error = `Discord: ${cResp.status} — ${friendlyDiscordError(cResp.status, await cResp.text())}`;
          }
        } catch (err) {
          error = err?.message ?? 'create-channel failed';
        }
      }

      if (channelId) {
        results.push({
          type: 'discord',
          ok: true,
          channelId: String(channelId),
          channelName: channelName ?? slug,
          created,
        });
        // Pre-bind so the bridge skips the "no project" dialogue for first message.
        if (bridge?.store) {
          bridge.store.bind({
            type: 'discord',
            botTokenHash: discordTokenHash(discord.token),
            targetKey: String(channelId),
            sessionId: '', // session is lazily created on first message
            projectPath: project.path,
            projectLabel,
          });
        }
        // Persist the project→channel binding so web conversations route into
        // this channel and the listener routes inbound back to this project —
        // without needing a manual "Sync now".
        await saveProjectBindings(
          upsertBinding(bindings, { channelId, projectPath: project.path, projectLabel }),
          discordSettings,
        );
        if (bridge?.worktreeSync) {
          void bridge.worktreeSync
            .refreshProjectHub({
              config: await bridge.worktreeSync.loadDiscordConfig(),
              projectRoot: project.path,
              projectLabel,
            })
            .catch(() => undefined);
        }
      } else {
        results.push({ type: 'discord', ok: false, error: error ?? 'create-channel failed' });
      }
    }

    broadcastEvent?.('messenger.bridge.project_autocreated', {
      projectId: project.id,
      projectLabel,
      results,
    });
    return results;
  }

  /**
   * Explicit endpoint — the UI calls this right after a project is added so
   * we don't tightly couple settings-runtime to messenger code.
   * Body: {
   *   project: { id, path, label },
   *   discord?: { token, guildId, parentCategoryId? }
   * }
   */
  router.post('/bridge/project-added', async (req, res) => {
    const { project, discord } = req.body ?? {};
    if (!project || !project.path) {
      return res.status(400).json({ ok: false, error: 'project { id, path, label } required' });
    }
    const results = await autoCreateMessengerSurfacesForProject(project, { discord });
    res.json({ ok: results.every((r) => r.ok), results });
  });

  /**
   * The UI renamed a project → rename its Discord channel to match and update
   * the persisted projectLabel on the binding. Creates the channel when the
   * project has no binding yet (so renaming a project OpenChamber agent never saw still
   * produces a channel). Best-effort — Discord errors are reported, not thrown.
   *
   * Body: { project: { id?, path, label }, discord: { token, guildId?, parentCategoryId? } }
   */
  router.post('/bridge/project-renamed', async (req, res) => {
    const { project, discord } = req.body ?? {};
    if (!project || !project.path) {
      return res.status(400).json({ ok: false, error: 'project { path, label } required' });
    }
    const token = discord?.token;
    if (!token) {
      return res.json({ ok: false, error: 'discord token required' });
    }
    const projectLabel = project.label ?? project.path.split('/').pop() ?? project.path;
    const slug = slugifyProjectLabel(projectLabel);
    const { discord: discordSettings, bindings } = await loadDiscordSettings();
    const binding = bindings.find((b) => b && b.channelId && b.projectPath === project.path);

    // No channel yet → create one (renaming an unmapped project should still
    // bring it into the per-project channel model).
    if (!binding) {
      const results = await autoCreateMessengerSurfacesForProject(project, { discord });
      const ok = results.find((r) => r.ok && r.channelId);
      return res.json({
        ok: Boolean(ok),
        channelId: ok?.channelId ?? null,
        channelName: ok?.channelName ?? null,
        created: true,
        error: ok ? null : results.find((r) => r.error)?.error ?? 'create failed',
      });
    }

    const channelId = String(binding.channelId);
    const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

    // Skip the Discord PATCH when the channel name already matches the slug —
    // this keeps a Discord-originated rename (which set the project label) from
    // bouncing back as a redundant rename request.
    let currentName = null;
    try {
      const gResp = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
        { headers: { Authorization: `Bot ${token}` } },
      );
      if (gResp.ok) currentName = (await gResp.json())?.name ?? null;
    } catch {
      // best-effort
    }

    let renamed = false;
    let error = null;
    if (currentName !== slug) {
      try {
        const pResp = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              name: slug,
              topic: `OpenChamber agent sync channel for ${projectLabel}`.slice(0, 1024),
            }),
          },
        );
        if (pResp.ok) {
          renamed = true;
        } else {
          error = `Discord: ${pResp.status} — ${friendlyDiscordError(pResp.status, await pResp.text())}`;
        }
      } catch (err) {
        error = err?.message ?? 'rename failed';
      }
    }

    // Keep the persisted label current regardless of whether the Discord rename
    // succeeded — resolveProjectChannel + the listener read projectLabel from here.
    await saveProjectBindings(
      bindings.map((b) =>
        b && b.projectPath === project.path ? { ...b, channelId, projectLabel } : b,
      ),
      discordSettings,
    );

    res.json({ ok: !error, channelId, channelName: slug, renamed, error });
  });

  /**
   * The UI removed a project → delete its Discord channel and drop the binding.
   * Best-effort — a missing channel (already deleted in Discord) still cleans up
   * the local binding so state can't drift.
   *
   * Body: { project: { id?, path, channelId? }, discord: { token } }
   */
  router.post('/bridge/project-removed', async (req, res) => {
    const { project, discord } = req.body ?? {};
    if (!project || !project.path) {
      return res.status(400).json({ ok: false, error: 'project { path } required' });
    }
    const token = discord?.token;
    const { discord: discordSettings, bindings } = await loadDiscordSettings();
    const binding = bindings.find((b) => b && b.channelId && b.projectPath === project.path);
    const channelId = binding?.channelId
      ? String(binding.channelId)
      : project.channelId
        ? String(project.channelId)
        : null;

    let deleted = false;
    let error = null;
    if (channelId && token && discord?.deleteChannel !== false) {
      try {
        const dResp = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
          { method: 'DELETE', headers: { Authorization: `Bot ${token}` } },
        );
        // 404 = channel already gone; treat as success for cleanup purposes.
        if (dResp.ok || dResp.status === 404) {
          deleted = true;
        } else {
          error = `Discord: ${dResp.status} — ${friendlyDiscordError(dResp.status, await dResp.text())}`;
        }
      } catch (err) {
        error = err?.message ?? 'delete failed';
      }
    }

    // Drop the binding from settings and the bridge store regardless of the
    // Discord delete result so the UI project removal is fully mirrored.
    if (binding) {
      await saveProjectBindings(
        bindings.filter((b) => !(b && b.projectPath === project.path)),
        discordSettings,
      );
    }
    if (channelId && token && bridge?.store) {
      try {
        bridge.store.unbind({
          type: 'discord',
          botTokenHash: discordTokenHash(token),
          targetKey: channelId,
        });
      } catch {
        // best-effort
      }
    }

    broadcastEvent?.('messenger.bridge.project_channel_removed', {
      type: 'discord',
      source: 'ui',
      channelId,
      projectPath: project.path,
      projectLabel: binding?.projectLabel ?? null,
    });

    res.json({ ok: !error, channelId, deleted, error });
  });

  /**
   * UI created a worktree → ensure a Discord thread + refresh the project hub index.
   * Body: {
   *   project: { id?, path, label? },
   *   worktree: { path, branch?, label? },
   *   sessionId?: string,
   *   discord?: { token, guildId?, parentCategoryId? }
   * }
   */
  router.post('/bridge/worktree-added', async (req, res) => {
    const { project, worktree, sessionId } = req.body ?? {};
    if (!project?.path || !worktree?.path) {
      return res.status(400).json({ ok: false, error: 'project.path and worktree.path required' });
    }
    if (!bridge?.worktreeSync) {
      return res.json({ ok: false, error: 'worktree sync is not available on this server' });
    }
    const result = await bridge.worktreeSync.handleWorktreeAdded({ project, worktree, sessionId });
    res.json(result);
  });

  /**
   * UI removed a worktree → archive its Discord thread and refresh the hub index.
   */
  router.post('/bridge/worktree-removed', async (req, res) => {
    const { project, worktree } = req.body ?? {};
    if (!worktree?.path) {
      return res.status(400).json({ ok: false, error: 'worktree.path required' });
    }
    if (!bridge?.worktreeSync) {
      return res.json({ ok: false, error: 'worktree sync is not available on this server' });
    }
    const result = await bridge.worktreeSync.handleWorktreeRemoved({ project, worktree });
    res.json(result);
  });

  /**
   * Worktree merged (UI integrate flow or Discord command) → post summary, archive thread.
   */
  router.post('/bridge/worktree-merged', async (req, res) => {
    const { project, worktree, summary } = req.body ?? {};
    if (!worktree?.path) {
      return res.status(400).json({ ok: false, error: 'worktree.path required' });
    }
    if (!bridge?.worktreeSync) {
      return res.json({ ok: false, error: 'worktree sync is not available on this server' });
    }
    const result = await bridge.worktreeSync.handleWorktreeMerged({ project, worktree, summary });
    res.json(result);
  });

  /**
   * Lookup the Discord URL for a worktree path (UI helper).
   */
  router.get('/bridge/worktree-discord-url', async (req, res) => {
    const worktreePath = typeof req.query?.path === 'string' ? req.query.path : null;
    if (!worktreePath) {
      return res.status(400).json({ ok: false, error: 'path query parameter required' });
    }
    if (!bridge?.worktreeSync) {
      return res.json({ ok: false, error: 'worktree sync is not available on this server' });
    }
    const discordUrl = await bridge.worktreeSync.lookupWorktreeDiscordUrl(worktreePath);
    if (!discordUrl) {
      return res.json({ ok: false, error: 'no Discord thread is bound to this worktree' });
    }
    return res.json({ ok: true, discordUrl, path: worktreePath });
  });

  /**
   * Refresh the pinned worktree index message for a project channel.
   */
  router.post('/bridge/worktree-refresh-index', async (req, res) => {
    const { project } = req.body ?? {};
    if (!project?.path) {
      return res.status(400).json({ ok: false, error: 'project.path required' });
    }
    if (!bridge?.worktreeSync) {
      return res.json({ ok: false, error: 'worktree sync is not available on this server' });
    }
    const config = await bridge.worktreeSync.loadDiscordConfig();
    const result = await bridge.worktreeSync.refreshProjectHub({
      config,
      projectRoot: project.path,
      projectLabel: project.label ?? null,
    });
    res.json(result);
  });

  /**
   * Bootstrap a new OpenChamber project from a Discord conversation
   * (or programmatically). Body: { action: 'clone'|'path'|'new', url?, path?, label? }.
   * Returns { ok, project } on success or { ok: false, error } on failure.
   * Powers the in-chat dialogue ("clone <url>" etc.) AND can be used by the
   * Settings UI directly.
   */
  /**
   * Per-project bridge defaults (model + agent). The same layer the
   * `/model default <p/m>` and `/agent default <name>` commands write to
   * from Discord — exposed here so the OpenChamber UI's project
   * settings can read/write the same values.
   *
   * POST body: { projectPath, projectLabel?, modelDefault?, agentDefault? }
   *   Omit a field to leave it unchanged. Pass null to clear it.
   * Returns: { ok, project: { projectPath, projectLabel, modelDefault, agentDefault } }
   */
  // Scheduled prompts live in OpenChamber's per-project scheduler
  // (`/api/projects/:projectId/scheduled-tasks`) — the Discord /schedule
  // command and the agent-facing instructions both target that API directly,
  // so there are no messenger-specific scheduling endpoints here.

  router.post('/bridge/project-defaults', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const { projectPath, projectLabel, modelDefault, agentDefault } = req.body ?? {};
    if (!projectPath) {
      return res.status(400).json({ ok: false, error: 'projectPath required' });
    }
    if (modelDefault != null && modelDefault !== '' && !/^[^/]+\/[^/]+$/.test(String(modelDefault))) {
      return res.status(400).json({ ok: false, error: 'modelDefault must be in "provider/model" form' });
    }
    bridge.store.setProjectDefaults({ projectPath, projectLabel, modelDefault, agentDefault });
    const updated = bridge.store.getProjectDefaults(projectPath);
    res.json({ ok: true, project: updated });
  });

  router.get('/bridge/project-defaults', (req, res) => {
    if (!bridge) return res.status(503).json({ ok: false, error: 'bridge unavailable' });
    const projectPath = typeof req.query?.projectPath === 'string' ? req.query.projectPath : '';
    if (projectPath) {
      const single = bridge.store.getProjectDefaults(projectPath);
      return res.json({ ok: true, project: single ?? null });
    }
    res.json({ ok: true, projects: bridge.store.listProjectDefaults() });
  });

  router.post('/bridge/bootstrap-project', async (req, res) => {
    if (!projectBootstrap) {
      return res
        .status(503)
        .json({ ok: false, error: 'project bootstrap is not wired in this server' });
    }
    const { action, url, path: targetPath, label } = req.body ?? {};
    if (!action || !['clone', 'path', 'new'].includes(action)) {
      return res
        .status(400)
        .json({ ok: false, error: "action must be one of 'clone' | 'path' | 'new'" });
    }
    try {
      const result = await projectBootstrap({ action, url, path: targetPath, label });
      return res.json(result);
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'bootstrap failed' });
    }
  });

  router.post('/discord/listener/start', async (req, res) => {
    const { token, guildId, autoReply, scopeToGuild, bridgeEnabled, projectBindings, defaultChannelId, defaultUserId } =
      req.body ?? {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const resolveProject = buildResolveProject(projectBindings);
    const result = discordListener.start(token, {
      guildId,
      autoReply: autoReply !== false,
      scopeToGuild: Boolean(scopeToGuild),
      bridgeEnabled: bridgeEnabled !== false && Boolean(bridge),
      resolveProject,
    });

    // The bridge mirrors OpenCode output via the shared global event hub —
    // make sure that upstream stream is running even when no browser client
    // ever connected to this server.
    if (typeof ensureEventStream === 'function') {
      Promise.resolve()
        .then(() => ensureEventStream())
        .catch((err) => console.warn('[MESSENGER] Failed to start global event stream:', err?.message ?? err));
    }

    // Persist the listener config (including the bot token) to settings.json so
    // the server auto-starts the listener on the next boot. We do this here —
    // server-side, at start time — rather than relying on the frontend's
    // separate best-effort saveDiscordConfig() call, which previously left the
    // `discord` block absent from settings.json and broke auto-start on restart.
    if (persistSettings) {
      try {
        const current = readSettings ? await readSettings() : null;
        const prev = current?.discord ?? {};
        // Persist the project→channel bindings so the OpenCode↔Discord bridge
        // can route web-UI conversations into each project's own channel
        // (instead of #general). Keep the previous map when none is sent.
        const normalizedBindings = Array.isArray(projectBindings)
          ? projectBindings
              .filter((b) => b && b.channelId && b.projectPath)
              .map((b) => ({
                channelId: String(b.channelId),
                projectPath: String(b.projectPath),
                projectLabel: b.projectLabel ? String(b.projectLabel) : undefined,
              }))
          : null;
        await persistSettings({
          discord: {
            ...prev,
            botToken: token,
            guildId: guildId || prev.guildId || undefined,
            autoReply: autoReply !== false,
            scopeToGuild: Boolean(scopeToGuild),
            bridgeEnabled: bridgeEnabled !== false,
            defaultChannelId: defaultChannelId || prev.defaultChannelId || undefined,
            defaultUserId: defaultUserId || prev.defaultUserId || undefined,
            projectBindings:
              normalizedBindings && normalizedBindings.length > 0
                ? normalizedBindings
                : prev.projectBindings || undefined,
          },
        });
      } catch {
        // best-effort — a failed persist must not block starting the listener
      }
    }

    res.json(result);
  });

  router.post('/discord/listener/stop', (req, res) => {
    const { token } = req.body ?? {};
    if (!token) return res.status(400).json({ error: 'token required' });
    res.json(discordListener.stop(token));
  });

  router.post('/discord/listener/status', (req, res) => {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    res.json(discordListener.status(token));
  });

  router.post('/discord/listener/recent', (req, res) => {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    res.json(discordListener.recent(token, req.body?.limit ?? 25));
  });

  /**
   * Save Discord listener config to settings.json so it survives server restarts.
   * Body matches the start endpoint: { botToken, guildId, autoReply, scopeToGuild, bridgeEnabled, defaultChannelId }.
   */
  router.post('/discord/save-config', async (req, res) => {
    const { botToken, guildId, autoReply, scopeToGuild, bridgeEnabled, defaultChannelId, defaultUserId, projectBindings, syncWorktrees } =
      req.body ?? {};
    try {
      // Merge with the previous discord block so this best-effort save (fired
      // by the frontend right after listener start) doesn't clobber the
      // project→channel bindings the start request just persisted.
      const current = readSettings ? await readSettings() : null;
      const prev = current?.discord ?? {};
      const normalizedBindings = Array.isArray(projectBindings)
        ? projectBindings
            .filter((b) => b && b.channelId && b.projectPath)
            .map((b) => ({
              channelId: String(b.channelId),
              projectPath: String(b.projectPath),
              projectLabel: b.projectLabel ? String(b.projectLabel) : undefined,
            }))
        : null;
      await persistSettings({
        discord: {
          ...prev,
          botToken: botToken || prev.botToken || undefined,
          guildId: guildId || prev.guildId || undefined,
          autoReply: autoReply !== false,
          scopeToGuild: Boolean(scopeToGuild),
          bridgeEnabled: bridgeEnabled !== false,
          defaultChannelId: defaultChannelId || prev.defaultChannelId || undefined,
          defaultUserId: defaultUserId || prev.defaultUserId || undefined,
          syncWorktrees: syncWorktrees !== false,
          projectBindings:
            normalizedBindings && normalizedBindings.length > 0
              ? normalizedBindings
              : prev.projectBindings || undefined,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err?.message ?? 'save failed' });
    }
  });

  /**
   * Read saved Discord listener config from settings.json.
   * Returns the discord config object (without botToken for safety) or null.
   */
  router.get('/discord/load-config', async (req, res) => {
    try {
      const settings = await readSettings();
      const config = settings?.discord ? { ...settings.discord } : null;
      // Omit the token from the response — it's sensitive. The frontend has it in localStorage.
      if (config) {
        const hasToken = Boolean(config.botToken);
        config.botToken = undefined;
        res.json({ ok: true, config, hasToken });
      } else {
        res.json({ ok: true, config: null, hasToken: false });
      }
    } catch (err) {
      res.status(500).json({ error: err?.message ?? 'load failed' });
    }
  });

  /**
   * Start the Discord listener from saved config (settings.json).
   * Used for auto-start on server boot.
   */
  router.post('/discord/auto-start', async (req, res) => {
    try {
      const settings = await readSettings();
      const discord = settings?.discord;
      if (!discord?.botToken) {
        return res.json({ ok: false, reason: 'not-configured' });
      }
      const result = discordListener.start(discord.botToken, {
        guildId: discord.guildId || undefined,
        autoReply: discord.autoReply !== false,
        scopeToGuild: Boolean(discord.scopeToGuild),
        bridgeEnabled: discord.bridgeEnabled !== false && Boolean(bridge),
        // Restore the persisted project→channel bindings so each Discord
        // channel keeps routing to its own project after a server restart.
        // Without this, every channel fell back to the first project until
        // the user re-opened Settings and re-sent a manual start.
        resolveProject: buildResolveProject(discord.projectBindings),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err?.message ?? 'auto-start failed' });
    }
  });

  /**
   * Fetch the last N messages from a Discord channel or thread via REST.
   * Body: { token, channelId, limit? } — limit clamped to 1..100.
   * Returns: { ok, messages: [{ id, content, author, timestamp, threadId }] }
   */
  router.post('/discord/history', async (req, res) => {
    const { token, channelId } = req.body ?? {};
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit ?? 50)));
    if (!token || !channelId) {
      return res.status(400).json({ error: 'token and channelId required' });
    }
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
        { headers: { Authorization: `Bot ${token}` } },
      );
      if (!r.ok) {
        const text = await r.text();
        return res.json({
          ok: false,
          error: `Discord: ${r.status} — ${friendlyDiscordError(r.status, text)}`,
        });
      }
      const raw = await r.json();
      const messages = (Array.isArray(raw) ? raw : []).map((m) => ({
        id: m.id,
        channelId: m.channel_id,
        content: m.content ?? '',
        timestamp: m.timestamp,
        author: {
          id: m.author?.id,
          username: m.author?.username ?? null,
          globalName: m.author?.global_name ?? null,
          isBot: Boolean(m.author?.bot),
        },
        attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0,
        threadId: null,
      }));
      return res.json({ ok: true, messages });
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'history fetch failed' });
    }
  });

  /**
   * Post an approval-request message with two buttons (Approve / Deny) in a
   * Discord channel. The button custom_ids embed the approvalId so the
   * gateway listener can route the click back as a structured event.
   *
   * Body: { token, channelId, prompt, approvalId?, permission? }
   * When `permission` is provided, rich context is rendered from its metadata.
   */
  router.post('/discord/send-approval', async (req, res) => {
    const { token, channelId, prompt, approvalId, permission } = req.body ?? {};
    if (!token || !channelId || !prompt) {
      return res.status(400).json({ error: 'token, channelId and prompt required' });
    }
    const id = approvalId || generateApprovalId();

    // Render rich permission context if provided
    const permissionContext = permission ? renderPermissionContext(permission) : '';
    const preamble = `**⚠️ Permission Required**\n**Type:** \`${escapeMd(String(permission?.permission ?? 'approval'))}\``;
    const bodyContent = permissionContext
      ? `${preamble}\n\n${permissionContext}\n\n${String(prompt).slice(0, 1000)}`
      : `**OpenChamber agent needs approval**\n${String(prompt).slice(0, 1600)}`;

    const body = {
      content: bodyContent.slice(0, 1900),
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 3, // SUCCESS (green)
              label: 'Approve',
              custom_id: `openchamber-agent-approve:${id}`,
            },
            {
              type: 2,
              style: 4, // DANGER (red)
              label: 'Deny',
              custom_id: `openchamber-agent-deny:${id}`,
            },
          ],
        },
      ],
    };
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const text = await r.text();
        return res.json({
          ok: false,
          error: `Discord: ${r.status} — ${friendlyDiscordError(r.status, text)}`,
        });
      }
      const data = await r.json();
      return res.json({
        ok: true,
        approvalId: id,
        messageId: data.id,
        channelId: data.channel_id ?? channelId,
        sentAt: new Date().toISOString(),
      });
    } catch (err) {
      return res.json({ ok: false, error: err?.message ?? 'send-approval failed' });
    }
  });

  /**
   * Discord setup diagnosis.
   * Verifies token, intents, guild access, default channel post + admin rights.
   * Body: { token, guildId?, channelId? }
   */
  router.post('/discord/diagnose', async (req, res) => {
    const { token, guildId, channelId } = req.body ?? {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const headers = { Authorization: `Bot ${token}` };
    const checks = [];
    const push = (c) => checks.push(c);

    let bot = null;
    try {
      const r = await fetch('https://discord.com/api/v10/users/@me', { headers });
      if (!r.ok) {
        const text = await r.text();
        push({
          id: 'token',
          ok: false,
          severity: 'error',
          title: 'Invalid bot token',
          detail: `Discord: ${r.status} — ${friendlyDiscordError(r.status, text)}`,
          fix: 'Re-paste the token from Discord Developer Portal → your app → Bot → Reset Token.',
        });
        return res.json({ ok: false, checks });
      }
      bot = await r.json();
      push({
        id: 'token',
        ok: true,
        severity: 'ok',
        title: `Bot is reachable as ${bot.username}${bot.discriminator && bot.discriminator !== '0' ? '#' + bot.discriminator : ''}`,
        detail: `Bot id ${bot.id}.`,
      });
    } catch (err) {
      push({
        id: 'token',
        ok: false,
        severity: 'error',
        title: 'Could not reach Discord',
        detail: err?.message ?? 'network error',
      });
      return res.json({ ok: false, checks });
    }

    // Intents check — REST doesn't expose intent state, so we infer from the
    // *live* listener. When the listener is currently connected the IDENTIFY
    // succeeded → MESSAGE_CONTENT is on. When it has actually delivered a
    // raw MESSAGE_CREATE event we have the strongest possible proof.
    const live = discordListener.inspect ? discordListener.inspect(token) : null;
    if (live?.connected) {
      if ((live.totalRawMessages ?? 0) > 0) {
        push({
          id: 'intents',
          ok: true,
          severity: 'ok',
          title: 'Message Content intent verified by live gateway',
          detail: `Listener has received ${live.totalRawMessages} raw MESSAGE_CREATE event${live.totalRawMessages === 1 ? '' : 's'}${live.lastRawMessageGuildId ? ` (most recent from guild ${live.lastRawMessageGuildId})` : ''}.`,
        });
        // Surface the guild-mismatch case if the user enabled scopeToGuild.
        if (
          live.scopeToGuild &&
          live.guildId &&
          live.lastRawMessageGuildId &&
          live.lastRawMessageGuildId !== live.guildId
        ) {
          push({
            id: 'guild-mismatch',
            ok: false,
            severity: 'warn',
            title: 'Saved Server ID does not match the guild the bot is hearing from',
            detail: `Listener filtered ${live.filteredOutCount} message${live.filteredOutCount === 1 ? '' : 's'} from guild ${live.lastFilteredGuildId ?? '?'} because the saved Server ID is ${live.guildId}.`,
            fix: 'Update the Server (Guild) ID to match the server you want, or disable scope-to-guild so messages from every server the bot is in reach the UI.',
          });
        }
      } else {
        push({
          id: 'intents',
          ok: true,
          severity: 'ok',
          title: 'Gateway IDENTIFY accepted',
          detail:
            'Listener is connected (no 4014). MESSAGE_CONTENT intent is requested and accepted — post a message in any channel the bot can see to confirm end-to-end.',
        });
      }
    } else if (live?.lastError && live.lastError.includes('4014')) {
      push({
        id: 'intents',
        ok: false,
        severity: 'error',
        title: 'Message Content intent NOT enabled in Developer Portal',
        detail: `Gateway closed with code 4014: ${live.lastError}`,
        fix: 'Developer Portal → your app → Bot → "Privileged Gateway Intents" → enable "MESSAGE CONTENT INTENT" → Save. Then restart the listener.',
      });
    } else {
      push({
        id: 'intents',
        ok: true,
        severity: 'info',
        title: 'Message Content intent must be enabled in Developer Portal',
        detail:
          "Otherwise the gateway will close with code 4014 and the listener won't see any non-mention messages. (Start the listener so this check can verify it live.)",
        fix: 'Developer Portal → your app → Bot → "Privileged Gateway Intents" → enable "MESSAGE CONTENT INTENT" → Save.',
      });
    }

    // Guild access
    if (guildId) {
      try {
        const r = await fetch(
          `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`,
          { headers },
        );
        if (!r.ok) {
          const text = await r.text();
          push({
            id: 'guild',
            ok: false,
            severity: 'error',
            title: 'Cannot access server',
            detail: `Discord: ${r.status} — ${friendlyDiscordError(r.status, text)}`,
            fix: 'Invite the bot to the server via the invite URL above.',
          });
          return res.json({ ok: false, checks });
        }
        const guild = await r.json();
        push({
          id: 'guild',
          ok: true,
          severity: 'ok',
          title: `Server "${guild.name}" reachable`,
          detail: `Server id ${guild.id}.`,
        });

        // Bot member + permissions
        try {
          const mResp = await fetch(
            `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(bot.id)}`,
            { headers },
          );
          if (mResp.ok) {
            const member = await mResp.json();
            const roleCount = Array.isArray(member.roles) ? member.roles.length : 0;
            push({
              id: 'membership',
              ok: true,
              severity: 'ok',
              title: 'Bot is a member of the server',
              detail: `Roles: ${roleCount}. (Channel-level rights are enforced per-channel; if posting fails, check the channel's Permissions.)`,
            });
          } else {
            push({
              id: 'membership',
              ok: false,
              severity: 'warn',
              title: 'Could not fetch bot membership',
              detail: `Discord: ${mResp.status} — ${friendlyDiscordError(mResp.status, await mResp.text())}`,
              fix: 'Ensure the bot is invited to the server.',
            });
          }
        } catch (err) {
          push({
            id: 'membership',
            ok: false,
            severity: 'warn',
            title: 'Membership check failed',
            detail: err?.message ?? 'network error',
          });
        }
      } catch (err) {
        push({
          id: 'guild',
          ok: false,
          severity: 'error',
          title: 'getGuild failed',
          detail: err?.message ?? 'network error',
        });
      }
    } else {
      push({
        id: 'guild',
        ok: false,
        severity: 'warn',
        title: 'No Server ID configured',
        detail: 'Add a Server ID to enable per-project channel + thread sync.',
      });
    }

    // Default channel post check
    if (channelId) {
      try {
        const r = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
          { headers },
        );
        if (!r.ok) {
          push({
            id: 'channel',
            ok: false,
            severity: 'error',
            title: 'Cannot access default channel',
            detail: `Discord: ${r.status} — ${friendlyDiscordError(r.status, await r.text())}`,
            fix: 'Right-click the channel → "Copy Channel ID" and re-save, or invite the bot to that channel.',
          });
        } else {
          const ch = await r.json();
          push({
            id: 'channel',
            ok: true,
            severity: 'ok',
            title: `Default channel #${ch.name} reachable`,
            detail: `Channel id ${ch.id} · type ${ch.type}.`,
          });
        }
      } catch (err) {
        push({
          id: 'channel',
          ok: false,
          severity: 'error',
          title: 'getChannel failed',
          detail: err?.message ?? 'network error',
        });
      }
    }

    return res.json({ ok: checks.every((c) => c.ok || c.severity === 'info'), checks });
  });

  /**
   * Build a Discord bot invite URL the user can click to add the bot to a server.
   * Body: { clientId, permissions? }
   *   - clientId: the bot/application id (returned by /test for discord)
   *   - permissions: integer bitfield; defaults to a conservative "Send Messages, Embed Links,
   *     Read Message History, View Channel" set so messenger sync can actually post.
   */
  router.post('/discord/invite-url', (req, res) => {
    const { clientId, permissions } = req.body ?? {};
    if (!clientId || typeof clientId !== 'string') {
      return res.status(400).json({ error: 'clientId required' });
    }
    // Default perms: View Channel (1<<10) | Send Messages (1<<11) | Embed Links (1<<14)
    //              | Read Message History (1<<16) = 117760
    const perms = typeof permissions === 'string' || typeof permissions === 'number'
      ? String(permissions)
      : '117760';
    const url =
      `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&permissions=${encodeURIComponent(perms)}&scope=bot%20applications.commands`;
    return res.json({ ok: true, url });
  });

  // Webhook for incoming messages from messengers
  router.post('/webhook/:type', (req, res) => {
    const { type } = req.params;
    const payload = req.body;

    if (!payload) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    broadcastEvent(`messenger.${type}.message`, {
      type,
      ...payload,
      receivedAt: new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  // Format adapter - converts between internal format and messenger-specific format
  router.post('/format', (req, res) => {
    const { target, content, format } = req.body ?? {};

    if (!target || !content) {
      return res.status(400).json({ error: 'target and content required' });
    }

    const formatted = adaptMessageFormat(content, format ?? 'markdown', target);
    res.json({ formatted, target });
  });

  return { router, discordListener };
}

/**
 * Adapts message content between different formatting standards.
 */
function adaptMessageFormat(content, sourceFormat, targetMessenger) {
  if (targetMessenger === 'discord') {
    return adaptToDiscord(content, sourceFormat);
  }
  return content;
}

function adaptToDiscord(content, _sourceFormat) {
  let text = content;
  // Truncate to Discord's 2000 char limit
  if (text.length > 2000) {
    text = text.slice(0, 1950) + '\n\n_…truncated_';
  }
  return text;
}
