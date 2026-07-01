import { Router } from 'express';

/**
 * Agent-facing Discord API.
 *
 * A small, high-level HTTP surface designed to be trivially delegated to an
 * AI agent: "find where this project / session lives in Discord, and post
 * something there". Unlike the lower-level `/discord/*` routes, this layer:
 *
 *   - resolves the bot token from saved settings server-side, so an agent
 *     never has to handle (or even see) the secret;
 *   - lets the caller address a destination by project name/path, by OpenCode
 *     session id, or by a raw channel/thread id or a discord.com URL;
 *   - returns a ready-to-share Discord deep link for every resolved target.
 *
 * Endpoints (mounted under /api/otto/messenger/agent):
 *   GET  /agent/help      — compact, self-describing usage docs
 *   GET  /agent/targets   — list project channels + live session threads + URLs
 *   POST /agent/resolve   — resolve a single target → { channelId, url } (no post)
 *   POST /agent/post      — post a message to a target → { messageIds, url }
 */

const DISCORD_LIMIT = 2000;
const SNOWFLAKE = /^\d{15,25}$/;
// SUPPRESS_NOTIFICATIONS — a "silent" message that doesn't ping anyone.
const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;

/** Parse a discord.com / discordapp.com channel or message URL into ids. */
export function parseDiscordUrl(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(
    /discord(?:app)?\.com\/channels\/(@me|\d{15,25})\/(\d{15,25})(?:\/(\d{15,25}))?/,
  );
  if (!m) return null;
  return {
    guildId: m[1] === '@me' ? null : m[1],
    channelId: m[2],
    messageId: m[3] ?? null,
  };
}

/** Build a Discord deep link for a channel/thread (and optionally a message). */
export function buildDiscordUrl({ guildId, channelId, messageId } = {}) {
  if (!channelId) return null;
  const guildSeg = guildId ? String(guildId) : '@me';
  const base = `https://discord.com/channels/${guildSeg}/${channelId}`;
  return messageId ? `${base}/${messageId}` : base;
}

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Split long text into Discord-sized chunks on line boundaries when possible. */
export function chunkForDiscord(text, limit = DISCORD_LIMIT) {
  let rest = String(text ?? '');
  if (rest.length <= limit) return rest.length ? [rest] : [];
  const out = [];
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    // Avoid pathologically tiny chunks when there's no newline near the edge.
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

function friendlyDiscordError(status, rawText) {
  const trimmed = (rawText ?? '').slice(0, 200);
  if (status === 401) return 'Invalid bot token.';
  if (status === 403) {
    return 'Bot has no access — invite it and grant View Channel + Send Messages.';
  }
  if (status === 404) return 'Channel or thread not found.';
  if (status === 429) return 'Rate-limited by Discord. Retry shortly.';
  return trimmed || `HTTP ${status}`;
}

export function createDiscordAgentRouter({
  readSettings = null,
  bridge = null,
  broadcastEvent = null,
  getLocalApiBaseUrl = null,
} = {}) {
  const router = Router();
  // The parent router already parses JSON, but keep this self-contained so the
  // sub-router can be mounted (and tested) on its own.
  router.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });

  // channelId → guildId, filled lazily from the Discord REST API so deep links
  // are correct even when a guild id isn't saved in settings. Names/ids are
  // effectively immutable, so a tiny in-memory cache is safe for the process.
  const guildIdCache = new Map();

  async function loadDiscordConfig() {
    if (!readSettings) return null;
    let settings;
    try {
      settings = await readSettings();
    } catch {
      return null;
    }
    const discord = settings?.discord ?? null;
    if (!discord?.botToken) return null;
    return {
      token: discord.botToken,
      guildId: discord.guildId ?? null,
      defaultChannelId: discord.defaultChannelId ?? null,
      projectBindings: Array.isArray(discord.projectBindings) ? discord.projectBindings : [],
    };
  }

  async function ensureGuildId(token, target) {
    if (!target || target.guildId || !target.channelId) return target;
    if (guildIdCache.has(target.channelId)) {
      target.guildId = guildIdCache.get(target.channelId);
      return target;
    }
    try {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(target.channelId)}`,
        { headers: { Authorization: `Bot ${token}` } },
      );
      if (r.ok) {
        const ch = await r.json();
        const gid = ch?.guild_id ?? null;
        guildIdCache.set(target.channelId, gid);
        target.guildId = gid;
      }
    } catch {
      // best-effort — a missing guild id only degrades the URL to /@me/...
    }
    return target;
  }

  function listProjectTargets(cfg) {
    return cfg.projectBindings
      .filter((b) => b && b.channelId)
      .map((b) => ({
        kind: 'project',
        sessionId: null,
        projectPath: b.projectPath ?? null,
        projectLabel: b.projectLabel ?? null,
        channelId: String(b.channelId),
        guildId: cfg.guildId ?? null,
        url: buildDiscordUrl({ guildId: cfg.guildId, channelId: b.channelId }),
      }));
  }

  function listSessionTargets(cfg) {
    if (!bridge?.store?.list) return [];
    let rows = [];
    try {
      rows = bridge.store.list({ type: 'discord' });
    } catch {
      return [];
    }
    return rows
      .filter((r) => r && r.sessionId && r.targetKey)
      .map((r) => ({
        kind: 'session',
        sessionId: r.sessionId,
        projectPath: r.projectPath ?? null,
        projectLabel: r.projectLabel ?? null,
        // For Discord, targetKey is the thread id (or channel id for DMs); it
        // doubles as the channel segment in a deep link.
        channelId: String(r.targetKey),
        guildId: cfg.guildId ?? null,
        lastUsedAt: r.lastUsedAt ?? null,
        url: buildDiscordUrl({ guildId: cfg.guildId, channelId: r.targetKey }),
      }));
  }

  function findProjectTarget(cfg, query) {
    const q = String(query).trim();
    const qSlug = slugify(q);
    const qLower = q.toLowerCase();
    const bindings = cfg.projectBindings.filter((b) => b && b.channelId);

    let match = bindings.find((b) => b.projectPath && b.projectPath === q);
    if (!match) {
      match = bindings.find((b) => {
        const cands = [
          slugify(b.projectLabel ?? ''),
          slugify((b.projectPath ?? '').split('/').pop() ?? ''),
        ].filter(Boolean);
        return qSlug.length > 0 && cands.includes(qSlug);
      });
    }
    if (!match) {
      match = bindings.find((b) => {
        const hay = `${b.projectLabel ?? ''} ${b.projectPath ?? ''}`.toLowerCase();
        return qLower.length > 0 && hay.includes(qLower);
      });
    }
    if (!match) return null;
    return {
      kind: 'project',
      sessionId: null,
      projectPath: match.projectPath ?? null,
      projectLabel: match.projectLabel ?? null,
      channelId: String(match.channelId),
      guildId: cfg.guildId ?? null,
    };
  }

  function findSessionTarget(cfg, sessionId) {
    const wanted = String(sessionId).trim();
    const sessions = listSessionTargets(cfg);
    const row = sessions.find((s) => s.sessionId === wanted);
    if (!row) return null;
    return {
      kind: 'session',
      sessionId: row.sessionId,
      projectPath: row.projectPath,
      projectLabel: row.projectLabel,
      channelId: row.channelId,
      guildId: cfg.guildId ?? null,
    };
  }

  /**
   * Resolve a destination from { project | session | channel }. `channel`
   * accepts a raw channel/thread snowflake or a discord.com URL.
   * Returns a target descriptor, or { error } when it cannot be resolved.
   */
  function resolveTarget(cfg, { project, session, channel } = {}) {
    const hasChannel = channel != null && String(channel).trim() !== '';
    const hasSession = session != null && String(session).trim() !== '';
    const hasProject = project != null && String(project).trim() !== '';

    if (hasChannel) {
      const raw = String(channel).trim();
      const parsed = parseDiscordUrl(raw);
      if (parsed) {
        return {
          kind: 'channel',
          sessionId: null,
          projectPath: null,
          projectLabel: null,
          channelId: parsed.channelId,
          guildId: parsed.guildId ?? cfg.guildId ?? null,
        };
      }
      if (SNOWFLAKE.test(raw)) {
        return {
          kind: 'channel',
          sessionId: null,
          projectPath: null,
          projectLabel: null,
          channelId: raw,
          guildId: cfg.guildId ?? null,
        };
      }
      return {
        error: `Could not parse channel "${raw}". Pass a Discord channel/thread ID or a discord.com/channels/… URL.`,
      };
    }

    if (hasSession) {
      const target = findSessionTarget(cfg, session);
      if (!target) {
        return {
          error: `No Discord thread is bound to session "${session}". Use GET /agent/targets to list bound sessions.`,
        };
      }
      return target;
    }

    if (hasProject) {
      const target = findProjectTarget(cfg, project);
      if (!target) {
        return {
          error: `No Discord channel is bound to a project matching "${project}". Use GET /agent/targets to list bound projects.`,
        };
      }
      return target;
    }

    return { error: 'Provide one of: project, session, or channel.' };
  }

  async function postMessage(token, channelId, content, { silent } = {}) {
    const chunks = chunkForDiscord(content);
    if (chunks.length === 0) return { ok: false, error: 'text is empty' };
    const messageIds = [];
    for (const chunk of chunks) {
      const body = { content: chunk };
      if (silent) body.flags = FLAG_SUPPRESS_NOTIFICATIONS;
      let r;
      try {
        r = await fetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
          {
            method: 'POST',
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      } catch (err) {
        return { ok: false, error: err?.message ?? 'send failed', messageIds };
      }
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return {
          ok: false,
          error: `Discord: ${r.status} — ${friendlyDiscordError(r.status, text)}`,
          messageIds,
        };
      }
      const data = await r.json().catch(() => null);
      if (data?.id) messageIds.push(data.id);
    }
    return { ok: true, messageIds };
  }

  function helpPayload() {
    const base = typeof getLocalApiBaseUrl === 'function' ? getLocalApiBaseUrl() : null;
    const api = base ? `${base}/api/otto/messenger/agent` : '/api/otto/messenger/agent';
    return {
      ok: true,
      summary:
        'Agent-facing Discord API. The bot token is resolved server-side — never pass it. Address a destination by project, session, or channel (raw id or discord.com URL).',
      endpoints: {
        'GET /agent/targets':
          'List project channels and live session threads, each with a Discord URL.',
        'POST /agent/resolve':
          'Resolve { project | session | channel } → { channelId, url } without posting.',
        'POST /agent/post':
          'Post { text, project | session | channel, silent? } → { messageIds, url }.',
      },
      examples: [
        `curl -s ${api}/targets`,
        `curl -s -X POST ${api}/post -H 'Content-Type: application/json' -d '{"project":"my-app","text":"Build is green ✅"}'`,
        `curl -s -X POST ${api}/post -H 'Content-Type: application/json' -d '{"session":"ses_123","text":"done"}'`,
        `curl -s -X POST ${api}/resolve -H 'Content-Type: application/json' -d '{"channel":"https://discord.com/channels/1/2"}'`,
      ],
    };
  }

  router.get('/help', (_req, res) => res.json(helpPayload()));

  router.get('/targets', async (_req, res) => {
    const cfg = await loadDiscordConfig();
    if (!cfg) {
      return res
        .status(503)
        .json({ ok: false, error: 'Discord is not configured (no bot token saved).' });
    }
    res.json({
      ok: true,
      guildId: cfg.guildId,
      projects: listProjectTargets(cfg),
      sessions: listSessionTargets(cfg),
    });
  });

  router.post('/resolve', async (req, res) => {
    const cfg = await loadDiscordConfig();
    if (!cfg) {
      return res
        .status(503)
        .json({ ok: false, error: 'Discord is not configured (no bot token saved).' });
    }
    const { project, session, channel } = req.body ?? {};
    const target = resolveTarget(cfg, { project, session, channel });
    if (target.error) return res.status(400).json({ ok: false, error: target.error });
    await ensureGuildId(cfg.token, target);
    res.json({
      ok: true,
      target: { ...target, url: buildDiscordUrl(target) },
    });
  });

  router.post('/post', async (req, res) => {
    const cfg = await loadDiscordConfig();
    if (!cfg) {
      return res
        .status(503)
        .json({ ok: false, error: 'Discord is not configured (no bot token saved).' });
    }
    const { project, session, channel, text, silent } = req.body ?? {};
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }
    const target = resolveTarget(cfg, { project, session, channel });
    if (target.error) return res.status(400).json({ ok: false, error: target.error });

    const result = await postMessage(cfg.token, target.channelId, text, {
      silent: Boolean(silent),
    });
    if (!result.ok) {
      return res.json({ ok: false, error: result.error, target: { ...target } });
    }

    await ensureGuildId(cfg.token, target);
    const firstMessageId = result.messageIds[0] ?? null;
    const url = buildDiscordUrl({ ...target, messageId: firstMessageId });
    try {
      broadcastEvent?.('messenger.discord.sent', {
        target: target.channelId,
        messageId: firstMessageId,
        via: 'agent-api',
      });
    } catch {
      // ignore — broadcasting is best-effort
    }
    res.json({
      ok: true,
      messageIds: result.messageIds,
      channelId: target.channelId,
      url,
      target: { ...target, url: buildDiscordUrl(target) },
      sentAt: new Date().toISOString(),
    });
  });

  return router;
}
