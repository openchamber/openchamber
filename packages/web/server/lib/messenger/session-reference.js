import { parseDiscordUrl, buildDiscordUrl } from './discord-agent-api.js';

const SNOWFLAKE = /^\d{15,25}$/;

function normalizeInput(input) {
  if (input == null) return '';
  return String(input).trim();
}

/**
 * Classify a pasted session reference.
 * Returns { kind, sessionId?, channelId?, raw }.
 */
export function parseSessionReferenceInput(input) {
  const raw = normalizeInput(input);
  if (!raw) return { kind: 'empty', raw };

  const discord = parseDiscordUrl(raw);
  if (discord?.channelId) {
    return { kind: 'discord', channelId: discord.channelId, guildId: discord.guildId ?? null, raw };
  }

  if (SNOWFLAKE.test(raw)) {
    return { kind: 'discord', channelId: raw, guildId: null, raw };
  }

  const shareMatch = raw.match(/\/share\/([A-Za-z0-9_-]+)\/?$/);
  if (shareMatch) {
    return { kind: 'shareUrl', shareKey: shareMatch[1], raw };
  }

  if (/^ses[_-]/i.test(raw) || /^[0-9a-f]{26,}$/i.test(raw)) {
    return { kind: 'sessionId', sessionId: raw, raw };
  }

  return { kind: 'unknown', raw };
}

function extractMessageText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function formatTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

/**
 * Turn OpenCode message records into compact markdown for agent consumption.
 */
export function formatSessionTranscriptMarkdown(records, { title = null, maxMessages = 500 } = {}) {
  const rows = Array.isArray(records) ? records.slice(-maxMessages) : [];
  const lines = [];
  if (title) {
    lines.push(`# ${title}`, '');
  }
  for (const record of rows) {
    const info = record?.info ?? record;
    const parts = record?.parts ?? [];
    if (!info || typeof info !== 'object') continue;
    const role = info.role === 'user' ? 'User' : info.role === 'assistant' ? 'Assistant' : String(info.role ?? 'Message');
    const text = extractMessageText(parts).trim();
    if (!text) continue;
    const when = formatTimestamp(info.time?.created);
    const header = when ? `**${role}** (${when})` : `**${role}**`;
    lines.push(header, '', text, '', '---', '');
  }
  return lines.join('\n').trim();
}

async function fetchJson(opencodeFetch, path) {
  const response = await opencodeFetch(path);
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function findSessionInProjects(sessionId, { listProjects, opencodeFetch }) {
  const projects = typeof listProjects === 'function' ? await listProjects() : [];
  const directories = [];
  for (const project of projects) {
    const path = typeof project?.path === 'string' ? project.path.trim() : '';
    if (path && !directories.includes(path)) directories.push(path);
  }

  for (const directory of directories) {
    const params = `?directory=${encodeURIComponent(directory)}`;
    const session = await fetchJson(
      opencodeFetch,
      `/session/${encodeURIComponent(sessionId)}${params}`,
    );
    if (session?.id === sessionId) {
      return { session, directory };
    }
  }

  const session = await fetchJson(opencodeFetch, `/session/${encodeURIComponent(sessionId)}`);
  if (session?.id === sessionId) {
    const directory =
      typeof session.directory === 'string'
        ? session.directory
        : typeof session.project?.worktree === 'string'
          ? session.project.worktree
          : null;
    return { session, directory };
  }

  return null;
}

function bindingFromDiscordChannel(store, channelId) {
  if (!store?.findByTargetKey || !channelId) return null;
  let rows = [];
  try {
    rows = store.findByTargetKey({ type: 'discord', targetKey: channelId });
  } catch {
    return null;
  }
  const row = rows.find((entry) => entry?.sessionId);
  return row ?? null;
}

function bindingFromSessionId(store, sessionId) {
  if (!store?.lookupBySessionId || !sessionId) return null;
  let rows = [];
  try {
    rows = store.lookupBySessionId(sessionId);
  } catch {
    return null;
  }
  return rows[0] ?? null;
}

/**
 * Resolve a session reference to { sessionId, directory, title, discordUrl, projectLabel }.
 */
export async function resolveSessionReference({
  input,
  store = null,
  readSettings = null,
  listProjects = null,
  opencodeFetch = null,
} = {}) {
  const parsed = parseSessionReferenceInput(input);
  if (parsed.kind === 'empty') {
    return { ok: false, error: 'reference is required' };
  }

  let sessionId = parsed.sessionId ?? null;
  let directory = null;
  let projectLabel = null;
  let discordUrl = null;
  let guildId = null;

  if (parsed.kind === 'discord') {
    const binding = bindingFromDiscordChannel(store, parsed.channelId);
    if (!binding?.sessionId) {
      return {
        ok: false,
        error: `No OpenChamber session is bound to Discord channel/thread "${parsed.channelId}".`,
      };
    }
    sessionId = binding.sessionId;
    directory = binding.projectPath ?? null;
    guildId = parsed.guildId ?? null;
    discordUrl = buildDiscordUrl({ guildId, channelId: parsed.channelId });
  }

  if (!sessionId && parsed.kind === 'shareUrl') {
    return {
      ok: false,
      error:
        'Share URLs cannot be resolved locally without the session id. Ask the user for the session id or a Discord thread URL instead.',
    };
  }

  if (!sessionId) {
    return { ok: false, error: `Could not parse session reference "${parsed.raw}".` };
  }

  if (!directory) {
    const binding = bindingFromSessionId(store, sessionId);
    if (binding?.projectPath) {
      directory = binding.projectPath;
      projectLabel = binding.projectLabel ?? null;
      if (binding.type === 'discord' && binding.targetKey) {
        let settingsGuildId = null;
        if (typeof readSettings === 'function') {
          try {
            const settings = await readSettings();
            settingsGuildId = settings?.discord?.guildId ?? null;
          } catch {
            // ignore
          }
        }
        discordUrl = buildDiscordUrl({
          guildId: settingsGuildId,
          channelId: binding.targetKey,
        });
      }
    }
  }

  let session = null;
  if (typeof opencodeFetch === 'function') {
    if (directory) {
      session = await fetchJson(
        opencodeFetch,
        `/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`,
      );
    }
    if (!session?.id) {
      const located = await findSessionInProjects(sessionId, { listProjects, opencodeFetch });
      if (located) {
        session = located.session;
        directory = located.directory ?? directory;
      }
    }
  }

  if (!directory && session) {
    directory =
      typeof session.directory === 'string'
        ? session.directory
        : typeof session.project?.worktree === 'string'
          ? session.project.worktree
          : null;
  }

  if (!session?.id) {
    return {
      ok: false,
      error: `Session "${sessionId}" was not found in any registered OpenChamber project.`,
    };
  }

  return {
    ok: true,
    sessionId,
    directory,
    title: typeof session.title === 'string' ? session.title : null,
    projectLabel,
    discordUrl,
    shareUrl: typeof session.share?.url === 'string' ? session.share.url : null,
    reference: discordUrl ?? sessionId,
  };
}

export async function readSessionTranscript({
  input,
  store = null,
  readSettings = null,
  listProjects = null,
  opencodeFetch = null,
  format = 'markdown',
  maxMessages = 500,
} = {}) {
  const resolved = await resolveSessionReference({
    input,
    store,
    readSettings,
    listProjects,
    opencodeFetch,
  });
  if (!resolved.ok) return resolved;

  const params = resolved.directory
    ? `?directory=${encodeURIComponent(resolved.directory)}`
    : '';
  const records = await fetchJson(
    opencodeFetch,
    `/session/${encodeURIComponent(resolved.sessionId)}/message${params}`,
  );
  const messages = Array.isArray(records) ? records : Array.isArray(records?.data) ? records.data : [];
  const transcript =
    format === 'json'
      ? messages
      : formatSessionTranscriptMarkdown(messages, {
          title: resolved.title,
          maxMessages,
        });

  return {
    ok: true,
    sessionId: resolved.sessionId,
    directory: resolved.directory,
    title: resolved.title,
    projectLabel: resolved.projectLabel,
    discordUrl: resolved.discordUrl,
    shareUrl: resolved.shareUrl,
    reference: resolved.reference,
    messageCount: messages.length,
    transcript,
  };
}

/**
 * Build the copyable reference for a known session id (UI helper).
 */
export async function buildSessionReferenceForId({
  sessionId,
  store = null,
  readSettings = null,
  listProjects = null,
  opencodeFetch = null,
} = {}) {
  const resolved = await resolveSessionReference({
    input: sessionId,
    store,
    readSettings,
    listProjects,
    opencodeFetch,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    sessionId: resolved.sessionId,
    reference: resolved.reference,
    discordUrl: resolved.discordUrl,
    shareUrl: resolved.shareUrl,
    title: resolved.title,
    directory: resolved.directory,
    projectLabel: resolved.projectLabel,
  };
}
