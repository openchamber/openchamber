/**
 * Discord ↔ git worktree sync for the OpenChamber messenger bridge.
 *
 * Mirrors the UI worktree model in Discord: one project channel, one thread per
 * worktree, plus a hub index message listing active worktrees.
 */

import crypto from 'node:crypto';
import {
  getStatus,
  getWorktrees,
  resolvePrimaryWorktreeRoot,
} from '../git/service.js';

const WORKTREE_PREFIX = '⬦ ';
const DISCORD_THREAD_NAME_MAX = 100;
const DISCORD_TOPIC_MAX = 1024;
const DISCORD_MESSAGE_MAX = 2000;

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
}

function pathsEqual(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return Boolean(left && right && left === right);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function hubIndexSettingKey(projectRoot) {
  return `worktree-index:${normalizePath(projectRoot)}`;
}

/** Format a Discord thread title for a worktree. */
export function formatWorktreeThreadName({ branch, label, statusSummary = null }) {
  const base = String(branch || label || 'worktree').trim() || 'worktree';
  const withPrefix = `${WORKTREE_PREFIX}${base}`;
  const full = statusSummary ? `${withPrefix} (${statusSummary})` : withPrefix;
  return full.slice(0, DISCORD_THREAD_NAME_MAX);
}

/** Summarise git status for thread titles / index rows. */
export function summarizeWorktreeGitStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const parts = [];
  const ahead = Number(status.ahead);
  const behind = Number(status.behind);
  if (Number.isFinite(ahead) && ahead > 0) parts.push(`+${ahead}`);
  if (Number.isFinite(behind) && behind > 0) parts.push(`-${behind}`);
  if (status.isDirty || status.dirty) parts.push('dirty');
  return parts.length > 0 ? parts.join('·') : 'clean';
}

async function discordFetch(path, { token, method = 'GET', body = null } = {}) {
  const headers = { Authorization: `Bot ${token}` };
  if (body != null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function addThreadMembers({ token, threadId, userIds }) {
  const ids = Array.isArray(userIds) ? userIds : userIds ? [userIds] : [];
  for (const userId of ids.filter(Boolean)) {
    await discordFetch(`/channels/${encodeURIComponent(threadId)}/thread-members/${encodeURIComponent(userId)}`, {
      token,
      method: 'PUT',
    }).catch(() => undefined);
  }
}

async function startStandaloneThread({ token, channelId, name, userIds }) {
  const safeName = (name || 'Otto worktree').replace(/\s+/g, ' ').slice(0, 90) || 'Otto worktree';
  const result = await discordFetch(`/channels/${encodeURIComponent(channelId)}/threads`, {
    token,
    method: 'POST',
    body: { name: safeName, type: 11, auto_archive_duration: 1440 },
  });
  if (!result.ok) {
    return { ok: false, error: `Discord ${result.status}: ${result.text.slice(0, 200)}` };
  }
  const threadId = result.json?.id ?? null;
  if (threadId && userIds) await addThreadMembers({ token, threadId, userIds });
  return { ok: true, threadId, threadName: result.json?.name ?? safeName };
}

async function deleteThread({ token, threadId }) {
  if (!threadId) return { ok: false, error: 'no thread id' };
  const result = await discordFetch(`/channels/${encodeURIComponent(threadId)}`, {
    token,
    method: 'DELETE',
  });
  if (result.ok || result.status === 404) return { ok: true };
  return { ok: false, error: `Discord ${result.status}: ${result.text.slice(0, 200)}` };
}

async function renameThread({ token, threadId, name }) {
  if (!threadId || !name) return { ok: false };
  const result = await discordFetch(`/channels/${encodeURIComponent(threadId)}`, {
    token,
    method: 'PATCH',
    body: { name: name.slice(0, DISCORD_THREAD_NAME_MAX) },
  });
  return { ok: result.ok, error: result.ok ? null : result.text.slice(0, 200) };
}

async function postChannelMessage({ token, channelId, content }) {
  const result = await discordFetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
    token,
    method: 'POST',
    body: { content: String(content).slice(0, DISCORD_MESSAGE_MAX) },
  });
  if (!result.ok) return { ok: false, error: result.text.slice(0, 200) };
  return { ok: true, messageId: result.json?.id ?? null };
}

async function editChannelMessage({ token, channelId, messageId, content }) {
  const result = await discordFetch(
    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    {
      token,
      method: 'PATCH',
      body: { content: String(content).slice(0, DISCORD_MESSAGE_MAX) },
    },
  );
  if (!result.ok) return { ok: false, error: result.text.slice(0, 200) };
  return { ok: true, messageId };
}

async function patchChannelTopic({ token, channelId, topic }) {
  const result = await discordFetch(`/channels/${encodeURIComponent(channelId)}`, {
    token,
    method: 'PATCH',
    body: { topic: String(topic).slice(0, DISCORD_TOPIC_MAX) },
  });
  return { ok: result.ok, error: result.ok ? null : result.text.slice(0, 200) };
}

export function createMessengerWorktreeSync({
  store,
  readSettings = null,
  persistSettings = null,
  broadcastEvent = null,
  resolveProjectChannel = null,
} = {}) {
  if (!store) {
    throw new Error('messenger worktree sync requires a bridge store');
  }

  async function loadDiscordConfig() {
    if (typeof readSettings !== 'function') return null;
    try {
      const settings = await readSettings();
      const discord = settings?.discord ?? null;
      if (!discord?.botToken) return null;
      return {
        token: discord.botToken,
        guildId: discord.guildId ?? null,
        defaultUserId: discord.defaultUserId ?? null,
        syncWorktrees: discord.syncWorktrees !== false,
        syncProjects: discord.syncProjects !== false,
        projectBindings: Array.isArray(discord.projectBindings) ? discord.projectBindings : [],
      };
    } catch {
      return null;
    }
  }

  function isSyncEnabled(config) {
    return Boolean(config?.token && config.syncWorktrees !== false && config.syncProjects !== false);
  }

  async function resolveProjectRoot(directory) {
    const normalized = normalizePath(directory);
    if (!normalized) return null;
    try {
      const resolved = await resolvePrimaryWorktreeRoot(normalized);
      return normalizePath(resolved?.root ?? normalized);
    } catch {
      return normalized;
    }
  }

  async function isWorktreeDirectory(directory, projectRoot = null) {
    const normalized = normalizePath(directory);
    const root = normalizePath(projectRoot ?? (await resolveProjectRoot(normalized)));
    if (!normalized || !root || pathsEqual(normalized, root)) return false;
    try {
      const entries = await getWorktrees(root);
      return entries.some((entry) => pathsEqual(entry.path, normalized));
    } catch {
      return false;
    }
  }

  async function readWorktreeGitStatus(worktreePath) {
    try {
      const status = await getStatus(worktreePath, { mode: 'light' });
      return {
        isDirty: status?.isClean === false,
        ahead: Number(status?.ahead) || 0,
        behind: Number(status?.behind) || 0,
        branch: typeof status?.branch === 'string' ? status.branch : null,
      };
    } catch {
      return { isDirty: false, ahead: 0, behind: 0, branch: null };
    }
  }

  async function listProjectWorktrees(projectRoot) {
    const root = normalizePath(projectRoot);
    if (!root) return [];
    const entries = await getWorktrees(root).catch(() => []);
    const secondary = entries.filter((entry) => entry?.path && !pathsEqual(entry.path, root));
    const results = [];
    for (const entry of secondary) {
      const path = normalizePath(entry.path);
      const branch = String(entry.branch || '').replace(/^refs\/heads\//, '').trim();
      const status = await readWorktreeGitStatus(path);
      const binding = store.lookupWorktreeByPath?.({
        botTokenHash: null,
        worktreePath: path,
      });
      results.push({
        path,
        branch: branch || status.branch || path.split('/').pop(),
        label: branch || path.split('/').pop(),
        status,
        threadId: binding?.threadId ?? null,
      });
    }
    results.sort((a, b) => a.branch.localeCompare(b.branch));
    return results;
  }

  function findWorktreeMatch(worktrees, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return null;
    return (
      worktrees.find((wt) => wt.branch.toLowerCase() === needle) ??
      worktrees.find((wt) => wt.path.toLowerCase().endsWith(`/${needle}`)) ??
      worktrees.find((wt) => wt.branch.toLowerCase().includes(needle)) ??
      worktrees.find((wt) => wt.path.toLowerCase().includes(needle)) ??
      null
    );
  }

  function resolveChannelForProject(config, projectRoot) {
    if (typeof resolveProjectChannel === 'function') {
      const resolved = resolveProjectChannel({ discord: config, projectPath: projectRoot });
      if (resolved?.channelId) return resolved;
    }
    const binding = config.projectBindings.find(
      (row) => row?.channelId && pathsEqual(row.projectPath, projectRoot),
    );
    if (binding?.channelId) {
      return { channelId: String(binding.channelId), projectLabel: binding.projectLabel ?? null };
    }
    return null;
  }

  function readHubIndexState(projectRoot) {
    const raw = store.getSetting?.(hubIndexSettingKey(projectRoot));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.channelId && parsed?.messageId) return parsed;
    } catch {
      // ignore
    }
    return null;
  }

  function writeHubIndexState(projectRoot, { channelId, messageId }) {
    if (!channelId || !messageId) {
      store.setSetting?.(hubIndexSettingKey(projectRoot), null);
      return;
    }
    store.setSetting?.(
      hubIndexSettingKey(projectRoot),
      JSON.stringify({ channelId: String(channelId), messageId: String(messageId) }),
    );
  }

  async function buildWorktreeIndexContent({ projectRoot, projectLabel, worktrees }) {
    const lines = [`**Worktrees** — ${projectLabel ?? projectRoot}`, ''];
    if (!worktrees || worktrees.length === 0) {
      lines.push('_(no active worktrees — create one in the UI or with `/new-worktree`)_');
    } else {
      for (const wt of worktrees) {
        const statusText = summarizeWorktreeGitStatus(wt.status) ?? 'unknown';
        const link = wt.threadId ? `<#${wt.threadId}>` : '_no thread_';
        lines.push(`• \`${wt.branch}\` — ${statusText} → ${link}`);
      }
    }
    lines.push('', '_Updated automatically by OpenChamber._');
    return lines.join('\n').slice(0, DISCORD_MESSAGE_MAX);
  }

  async function refreshProjectHub({ config, projectRoot, projectLabel = null }) {
    if (!isSyncEnabled(config)) return { ok: false, skipped: true };
    const channel = resolveChannelForProject(config, projectRoot);
    if (!channel?.channelId) return { ok: false, error: 'no project channel' };

    const worktrees = await listProjectWorktreesForBindings(config, projectRoot);
    const content = await buildWorktreeIndexContent({
      projectRoot,
      projectLabel: projectLabel ?? channel.projectLabel ?? projectRoot.split('/').pop(),
      worktrees,
    });

    const hub = readHubIndexState(projectRoot);
    let messageId = hub?.messageId ?? null;
    if (messageId && hub?.channelId === channel.channelId) {
      const edited = await editChannelMessage({
        token: config.token,
        channelId: channel.channelId,
        messageId,
        content,
      });
      if (!edited.ok) messageId = null;
    }
    if (!messageId) {
      const posted = await postChannelMessage({
        token: config.token,
        channelId: channel.channelId,
        content,
      });
      if (!posted.ok) return { ok: false, error: posted.error ?? 'post failed' };
      messageId = posted.messageId;
      writeHubIndexState(projectRoot, { channelId: channel.channelId, messageId });
    }

    const defaultBranch = worktrees[0]?.status?.branch ?? 'main';
    const topic = `OpenChamber · ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'} · ${projectLabel ?? projectRoot.split('/').pop()}`
      .slice(0, DISCORD_TOPIC_MAX);
    await patchChannelTopic({ token: config.token, channelId: channel.channelId, topic }).catch(() => undefined);

    broadcastEvent?.('messenger.bridge.worktree_index_updated', {
      projectRoot,
      channelId: channel.channelId,
      worktreeCount: worktrees.length,
    });

    return { ok: true, messageId, worktreeCount: worktrees.length, topic };
  }

  async function listProjectWorktreesForBindings(config, projectRoot) {
    const hash = tokenHash(config.token);
    const bound = store.listWorktreesForProject?.({ botTokenHash: hash, projectRoot }) ?? [];
    const boundByPath = new Map(bound.map((row) => [normalizePath(row.worktreePath), row]));
    const discovered = await listProjectWorktrees(projectRoot);
    return discovered.map((wt) => {
      const binding = boundByPath.get(normalizePath(wt.path));
      return {
        ...wt,
        threadId: binding?.threadId ?? wt.threadId ?? null,
        branch: binding?.branch ?? wt.branch,
      };
    });
  }

  async function ensureWorktreeThread({
    projectRoot,
    worktreePath,
    branch,
    label = null,
    sessionId = null,
    projectLabel = null,
    config: configOverride = null,
  }) {
    const config = configOverride ?? (await loadDiscordConfig());
    if (!isSyncEnabled(config)) return { ok: false, skipped: true, reason: 'sync-disabled' };

    const root = normalizePath(projectRoot ?? (await resolveProjectRoot(worktreePath)));
    const path = normalizePath(worktreePath);
    if (!root || !path) return { ok: false, error: 'invalid paths' };

    const channel = resolveChannelForProject(config, root);
    if (!channel?.channelId) return { ok: false, error: 'no project channel mapped' };

    const hash = tokenHash(config.token);
    const existing = store.lookupWorktreeByPath?.({ botTokenHash: hash, worktreePath: path });
    if (existing?.threadId) {
      if (sessionId) {
        store.bind?.({
          type: 'discord',
          botTokenHash: hash,
          targetKey: String(existing.threadId),
          sessionId,
          projectPath: path,
          projectLabel: projectLabel ?? `${channel.projectLabel ?? 'project'} (${existing.branch ?? branch ?? 'worktree'})`,
          projectRoot: root,
          worktreePath: path,
          branch: existing.branch ?? branch ?? null,
        });
      }
      return { ok: true, threadId: existing.threadId, created: false, channelId: existing.channelId };
    }

    const status = await readWorktreeGitStatus(path);
    const effectiveBranch = branch || status.branch || label || path.split('/').pop();
    const threadName = formatWorktreeThreadName({
      branch: effectiveBranch,
      label,
      statusSummary: summarizeWorktreeGitStatus(status),
    });

    const created = await startStandaloneThread({
      token: config.token,
      channelId: channel.channelId,
      name: threadName,
      userIds: config.defaultUserId,
    });
    if (!created.ok || !created.threadId) {
      return { ok: false, error: created.error ?? 'thread creation failed' };
    }

    store.bindWorktree?.({
      botTokenHash: hash,
      projectRoot: root,
      worktreePath: path,
      branch: effectiveBranch,
      channelId: channel.channelId,
      threadId: created.threadId,
    });

    if (sessionId) {
      store.bind?.({
        type: 'discord',
        botTokenHash: hash,
        targetKey: String(created.threadId),
        sessionId,
        projectPath: path,
        projectLabel: projectLabel ?? `${channel.projectLabel ?? 'project'} (${effectiveBranch})`,
        projectRoot: root,
        worktreePath: path,
        branch: effectiveBranch,
      });
    }

    await refreshProjectHub({ config, projectRoot: root, projectLabel: channel.projectLabel ?? projectLabel });
    broadcastEvent?.('messenger.bridge.worktree_thread_created', {
      projectRoot: root,
      worktreePath: path,
      branch: effectiveBranch,
      threadId: created.threadId,
      channelId: channel.channelId,
      source: sessionId ? 'session' : 'worktree',
    });

    return {
      ok: true,
      threadId: created.threadId,
      channelId: channel.channelId,
      created: true,
      branch: effectiveBranch,
    };
  }

  async function removeWorktreeThread({ worktreePath, projectRoot = null, archiveOnly = true }) {
    const config = await loadDiscordConfig();
    if (!config?.token) return { ok: false, error: 'discord not configured' };
    const hash = tokenHash(config.token);
    const path = normalizePath(worktreePath);
    const binding = store.lookupWorktreeByPath?.({ botTokenHash: hash, worktreePath: path });
    if (!binding?.threadId) {
      store.unbindWorktree?.({ botTokenHash: hash, worktreePath: path });
      return { ok: true, removed: false };
    }

    if (archiveOnly) {
      await deleteThread({ token: config.token, threadId: binding.threadId }).catch(() => undefined);
    }
    store.unbindWorktree?.({ botTokenHash: hash, worktreePath: path });

    const root = normalizePath(projectRoot ?? binding.projectRoot);
    if (root) {
      await refreshProjectHub({ config, projectRoot: root });
    }

    broadcastEvent?.('messenger.bridge.worktree_thread_removed', {
      projectRoot: root,
      worktreePath: path,
      threadId: binding.threadId,
    });

    return { ok: true, removed: true, threadId: binding.threadId };
  }

  async function handleWorktreeAdded({
    project,
    worktree,
    sessionId = null,
  }) {
    const config = await loadDiscordConfig();
    if (!isSyncEnabled(config)) return { ok: true, skipped: true };

    const projectRoot = normalizePath(project?.path);
    const worktreePath = normalizePath(worktree?.path);
    if (!projectRoot || !worktreePath) return { ok: false, error: 'project and worktree paths required' };

    return ensureWorktreeThread({
      projectRoot,
      worktreePath,
      branch: worktree?.branch ?? worktree?.label ?? null,
      label: worktree?.label ?? null,
      sessionId,
      projectLabel: project?.label ?? null,
      config,
    });
  }

  async function handleWorktreeRemoved({ project, worktree }) {
    const projectRoot = normalizePath(project?.path);
    const worktreePath = normalizePath(worktree?.path);
    if (!worktreePath) return { ok: false, error: 'worktree path required' };
    return removeWorktreeThread({ worktreePath, projectRoot });
  }

  async function handleWorktreeMerged({ project, worktree, summary = null }) {
    const config = await loadDiscordConfig();
    const projectRoot = normalizePath(project?.path);
    const worktreePath = normalizePath(worktree?.path);
    const hash = config?.token ? tokenHash(config.token) : null;
    const binding =
      hash && worktreePath
        ? store.lookupWorktreeByPath?.({ botTokenHash: hash, worktreePath })
        : null;

    if (binding?.threadId && config?.token) {
      const content = summary
        ? `✓ ${summary}\n\n_This worktree thread will be archived._`
        : '✓ Worktree merged into the default branch.\n\n_This worktree thread will be archived._';
      await postChannelMessage({
        token: config.token,
        channelId: binding.threadId,
        content,
      }).catch(() => undefined);
    }

    const removed = await removeWorktreeThread({ worktreePath, projectRoot });
    if (projectRoot && config) {
      await refreshProjectHub({ config, projectRoot, projectLabel: project?.label ?? null });
    }
    return removed;
  }

  async function handleSessionDirectoryBound({
    sessionId,
    directory,
    projectLabel = null,
    title = null,
  }) {
    const config = await loadDiscordConfig();
    if (!isSyncEnabled(config) || !sessionId || !directory) return { ok: true, skipped: true };

    const path = normalizePath(directory);
    const root = await resolveProjectRoot(path);
    if (!root || pathsEqual(path, root)) return { ok: true, skipped: true };
    const isWorktree = await isWorktreeDirectory(path, root);
    if (!isWorktree) return { ok: true, skipped: true };

    const result = await ensureWorktreeThread({
      projectRoot: root,
      worktreePath: path,
      branch: null,
      label: title,
      sessionId,
      projectLabel,
      config,
    });

    if (result.ok && result.threadId && title) {
      const status = await readWorktreeGitStatus(path);
      const threadName = formatWorktreeThreadName({
        branch: result.branch ?? status.branch,
        label: title,
        statusSummary: summarizeWorktreeGitStatus(status),
      });
      await renameThread({ token: config.token, threadId: result.threadId, name: threadName }).catch(() => undefined);
    }

    return result;
  }

  async function lookupWorktreeDiscordUrl(worktreePath) {
    const config = await loadDiscordConfig();
    if (!config?.token || !config.guildId) return null;
    const binding = store.lookupWorktreeByPath?.({
      botTokenHash: tokenHash(config.token),
      worktreePath: normalizePath(worktreePath),
    });
    if (!binding?.threadId) return null;
    return `https://discord.com/channels/${config.guildId}/${binding.threadId}`;
  }

  return {
    isSyncEnabled,
    loadDiscordConfig,
    resolveProjectRoot,
    isWorktreeDirectory,
    listProjectWorktrees,
    listProjectWorktreesForBindings,
    findWorktreeMatch,
    formatWorktreeThreadName,
    summarizeWorktreeGitStatus,
    ensureWorktreeThread,
    removeWorktreeThread,
    refreshProjectHub,
    handleWorktreeAdded,
    handleWorktreeRemoved,
    handleWorktreeMerged,
    handleSessionDirectoryBound,
    lookupWorktreeDiscordUrl,
    readWorktreeGitStatus,
  };
}
