/**
 * Text-prefix command system for Discord + Telegram bots.
 *
 * Mirrors the slash commands available in the OpenChamber web chat input
 * (`/undo`, `/redo`, `/compact`, `/summary`, `/init`, `/review` + dynamic
 * project commands) and adds the session-control set
 * (`/abort`, `/new`, `/model`, `/agent`, `/sessions`, `/status`, `/help`).
 *
 * Why text-prefix instead of native Discord slash commands:
 *   - Telegram doesn't have native slash commands — BotFather just hints
 *     at them in the autocomplete, the actual dispatch is plain text parsing.
 *     So we'd need text parsing for Telegram anyway.
 *   - Native Discord slash command registration requires per-bot writes to
 *     `PUT /applications/:app_id/commands`, has guild scope vs global scope
 *     decisions, and re-registration after every bot restart. Skipping that
 *     keeps a fresh bot working out of the box. Native registration can be
 *     a follow-up.
 *
 * Resolution model:
 *   - Per-surface (channel + thread) overrides for `model` and `agent` are
 *     stored in the bridge SQLite store. When a `prompt_async` is sent, the
 *     bridge picks them up.
 *   - `/abort`, `/undo`, `/redo`, `/compact`, `/summary` operate on the
 *     CURRENT bound session for the surface (via OpenCode REST).
 *   - `/new` unbinds the surface so the next prompt creates a fresh session.
 *   - `/init`, `/review`, and any other registered OpenCode command pass
 *     through to `POST /session/:id/command`.
 *   - `/help`, `/status`, `/sessions`, `/model`, `/agent` (no args) reply
 *     with text — they don't reach OpenCode.
 */

import crypto from 'node:crypto';
import { parseVerbosityLevel, VERBOSITY_LEVELS } from './messenger-verbosity.js';
import {
  parsePermissionMode,
  PERMISSION_MODES,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
} from './messenger-permissions.js';

const VERBOSITY_DESCRIPTIONS = {
  quiet: 'final answer only — hides reasoning and tool activity',
  normal: 'compact activity feed — tool names + a thinking marker, no payloads (default)',
  verbose: 'full detail — commands, diffs, outputs and reasoning, formatted for reading',
};

// Commands we recognise. The `usage` text is shown by /help so order matters.
const COMMAND_HELP = [
  { name: 'help', usage: '/help', summary: 'Show this list' },
  {
    name: 'status',
    usage: '/status',
    summary: 'Show the current session, project, model and agent for this conversation',
  },
  {
    name: 'add-project',
    usage: '/add-project <absolute-path> [label]',
    summary: 'Register an existing directory as an OpenChamber project and bind this Discord channel',
  },
  {
    name: 'create-new-project',
    usage: '/create-new-project <name-or-absolute-path>',
    summary: 'Create a folder, register it as a project, and ensure the Discord project channel exists',
  },
  {
    name: 'remove-project',
    usage: '/remove-project',
    summary: 'Unbind this Discord channel from its project without deleting files or Discord history',
  },
  { name: 'abort', usage: '/abort', summary: 'Stop the current OpenCode turn' },
  {
    name: 'new',
    usage: '/new',
    summary: 'Drop the current session and start a fresh one on the next message',
  },
  { name: 'undo', usage: '/undo', summary: 'Revert one user message' },
  { name: 'redo', usage: '/redo', summary: 'Step forward through undo' },
  {
    name: 'compact',
    usage: '/compact',
    summary: 'Summarise + compact the session history (destructive)',
  },
  {
    name: 'summary',
    usage: '/summary [topic]',
    summary: 'Non-destructive summary of the session',
  },
  { name: 'init', usage: '/init', summary: 'Run OpenCode `init` (creates/updates AGENTS.md)' },
  { name: 'review', usage: '/review', summary: 'Run OpenCode `review` workflow' },
  {
    name: 'diff',
    usage: '/diff',
    summary: 'Show a reviewable git diff for this conversation\'s bound project/worktree',
  },
  {
    name: 'tunnel',
    usage: '/tunnel [cloudflare|ngrok] [quick|managed-local|managed-remote]',
    summary:
      'Expose the running OpenChamber web server via the configured tunnel provider (not an arbitrary local port) and reply with the public URL',
  },
  {
    name: 'login',
    usage: '/login [provider]',
    summary: 'Start the provider auth flow using OpenCode auth endpoints (OAuth link or API-key guidance)',
  },
  {
    name: 'usage',
    usage: '/usage',
    summary: 'Show estimated token usage for the current session (`/credits` is an alias)',
  },
  {
    name: 'shell',
    usage: '/shell <command>',
    summary:
      'Run a shell command in the project and show the output here. On Discord just prefix with `!` — `!pwd`, `!git status`, `!ls -la`; elsewhere use `/shell pwd`.',
  },
  {
    name: 'model',
    usage: '/model [provider/model | default provider/model | reset]',
    summary:
      'List models / set this conversation\'s model / `default provider/model` sets a project-wide default.',
  },
  {
    name: 'agent',
    usage: '/agent [name | default name | reset]',
    summary: 'List agents / set this conversation\'s agent / `default name` sets a project-wide default.',
  },
  {
    name: 'verbosity',
    usage: '/verbosity [quiet | normal | verbose | default <level> | reset]',
    summary:
      'How much OpenChamber agent streams back: `quiet` = answer only, `normal` = tool names + thinking marker, `verbose` = full commands/diffs/outputs. `default <level>` sets the messenger-wide default.',
  },
  {
    name: 'skill',
    usage: '/skill [name]',
    summary:
      'List the skills available to the agent / hand one to OpenChamber agent for the next turn. On Discord, run `/skill` for a dropdown picker.',
  },
  {
    name: 'yolo',
    usage: '/yolo|/permissions [ask | auto-edit | yolo | project <mode> | default <mode> | reset]',
    summary:
      'How OpenChamber agent handles tool permissions: `ask` = always ask, `auto-edit` = allow non-destructive tools (still ask for shell), `yolo` = allow all. `/permissions` is a synonym. On Discord, run `/yolo` or `/permissions` for a dropdown. Stop any run with `/abort`.',
  },
  {
    name: 'sessions',
    usage: '/sessions',
    summary: 'List recent OpenCode sessions for this project',
  },
  {
    name: 'session',
    usage: '/session <prompt>',
    summary: 'Start a brand-new session (and thread) with the given prompt',
  },
  {
    name: 'resume',
    usage: '/resume [n | session-id]',
    summary: 'Resume a previous session — `/resume` lists candidates, `/resume 2` opens one in a new thread',
  },
  {
    name: 'fork',
    usage: '/fork [n]',
    summary: 'Branch from an earlier user message — `/fork` lists messages, `/fork 2` forks in a new thread',
  },
  {
    name: 'btw',
    usage: '/btw <side question>',
    summary: 'Fork the current session into a new thread and answer a side question without interrupting this run',
  },
  { name: 'share', usage: '/share', summary: 'Generate a public URL for the current session' },
  { name: 'unshare', usage: '/unshare', summary: 'Revoke the public URL for the current session' },
  {
    name: 'queue',
    usage: '/queue <message>',
    summary: 'Queue a message to send automatically after the current response finishes; suffix with `. queue` too',
  },
  { name: 'clear-queue', usage: '/clear-queue [n]', summary: 'Clear all queued messages, or one queued position' },
  {
    name: 'mention-mode',
    usage: '/mention-mode',
    summary: 'Toggle mention-only mode — when on, new sessions in this channel need an @mention',
  },
  {
    name: 'new-worktree',
    usage: '/new-worktree [name]',
    summary: 'Create an isolated git worktree + branch and work there in a new thread',
  },
  {
    name: 'worktrees',
    usage: '/worktrees',
    summary: 'List git worktrees for this channel project',
  },
  {
    name: 'toggle-worktrees',
    usage: '/toggle-worktrees [on|off]',
    summary: 'Toggle the project default that creates a worktree for new Discord sessions',
  },
  {
    name: 'merge-worktree',
    usage: '/merge-worktree',
    summary: 'Squash-merge this worktree\'s commits into the default branch',
  },
  {
    name: 'mcp',
    usage: '/mcp [connect|disconnect <server>]',
    summary:
      'List configured MCP servers, or update OpenCode config connect/disconnect + refresh (not a live MCP process manager)',
  },
  {
    name: 'context-usage',
    usage: '/context-usage',
    summary: 'Show token/context usage for the current session',
  },
  {
    name: 'session-id',
    usage: '/session-id',
    summary: 'Show the current OpenCode session id and copyable Discord/session reference',
  },
  {
    name: 'schedule',
    usage: '/schedule <when> [model=p/m] [agent=name] <prompt> | list | delete <id>',
    summary:
      'Schedule a prompt in the project scheduler (synced with the web UI) — `when` is a UTC ISO date (2026-03-01T09:00) or cron (`0 9 * * 1`, UTC). Each run starts a fresh session in the project.',
  },
  {
    name: 'queue-command',
    usage: '/queue-command <opencode-command> [args]',
    summary: 'Queue an OpenCode slash command to run after the current response finishes (in-memory until idle)',
  },
  {
    name: 'reload-opencode',
    usage: '/reload-opencode',
    summary:
      'Ask OpenChamber to reload/reconnect its managed OpenCode path (cannot kill/restart an external OpenCode process)',
  },
];

/** Aliases for COMMAND_HELP entries — recognised by the gate but not listed twice in `/help`. */
const COMMAND_ALIASES = new Map([
  ['permissions', 'yolo'],
  ['credits', 'usage'],
  ['restart-opencode-server', 'reload-opencode'],
]);

const KNOWN_TOP_LEVEL = new Set([
  ...COMMAND_HELP.map((c) => c.name),
  ...COMMAND_ALIASES.keys(),
]);

/**
 * Whether `name` is a recognised console command (`/help`, `/status`, …).
 * Used by the Discord inbound pipeline to tell a console command apart from a
 * bare `!shellcommand` (e.g. `!pwd`), which should run as a shell command.
 */
export function isKnownMessengerCommand(name) {
  return typeof name === 'string' && KNOWN_TOP_LEVEL.has(name.toLowerCase());
}

/**
 * Extract the leading slash command from a user message. Returns `null`
 * when the message is a normal prompt.
 *
 * Only the FIRST non-empty
 * line matters. Multi-line messages where the first line is a `/cmd` are
 * still treated as commands so users can paste context after a `/init`.
 *
 * @param {string} text
 * @param {{ allowBang?: boolean }} [options] - when `allowBang` is true, a
 *   leading `!` is accepted as an alias for `/`. Discord reserves `/` for its
 *   native slash-command UI, so `!cmd` is the natural text-command prefix
 *   there and must reach the same console command pipeline as `/cmd`.
 */
export function parseLeadingCommand(text, { allowBang = false } = {}) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const prefix = trimmed[0];
  if (prefix !== '/' && !(allowBang && prefix === '!')) return null;
  const firstLine = trimmed.split('\n')[0];
  const m = firstLine.match(/^[/!]([A-Za-z][A-Za-z0-9_-]*)\b\s*(.*)$/);
  if (!m) return null;
  return {
    name: m[1].toLowerCase(),
    args: (m[2] ?? '').trim(),
    // Everything AFTER the first line — for /init / /review style commands
    // where the user pasted additional context.
    body: trimmed.includes('\n') ? trimmed.split('\n').slice(1).join('\n').trim() : '',
  };
}

export function stripBtwSuffix(text) {
  if (typeof text !== 'string') return null;
  const original = text.trim();
  if (!original) return null;

  const finalLineMatch = original.match(/^(?<body>[\s\S]*?)\n\s*btw\s*$/i);
  if (finalLineMatch?.groups?.body?.trim()) {
    return { text: finalLineMatch.groups.body.trim(), suffix: 'final-line' };
  }

  const punctuationMatch = original.match(/^(?<body>[\s\S]*?)[.!]\s+btw\s*$/i);
  if (punctuationMatch?.groups?.body?.trim()) {
    return { text: punctuationMatch.groups.body.trim(), suffix: 'punctuation' };
  }

  const trailingSentenceMatch = original.match(/^(?<body>[\s\S]*?)\s+btw\.\s*$/i);
  if (trailingSentenceMatch?.groups?.body?.trim()) {
    return { text: trailingSentenceMatch.groups.body.trim(), suffix: 'trailing-sentence' };
  }

  return null;
}

export function stripQueueSuffix(text) {
  if (typeof text !== 'string') return null;
  const original = text.trim();
  if (!original) return null;
  const match = original.match(/^(?<body>[\s\S]*?)[.!]\s+queue\s*$/i);
  if (!match?.groups?.body?.trim()) return null;
  return { text: match.groups.body.trim(), suffix: 'punctuation' };
}

function tokenHash(token) {
  if (!token) return '';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function targetKey({ type, channelId, threadId }) {
  if (type === 'discord') return threadId ? `${threadId}` : `${channelId}`;
  return threadId ? `${channelId}:${threadId}` : `${channelId}`;
}

function fmtTable(rows, columns) {
  // Compact markdown-ish list (no real table — Discord doesn't render them).
  const lines = [];
  for (const r of rows) {
    const parts = columns.map((c) => {
      const v = r[c.key];
      if (v == null || v === '') return null;
      if (c.code) return `\`${String(v)}\``;
      if (c.italic) return `_${String(v)}_`;
      return String(v);
    }).filter(Boolean);
    lines.push(parts.join(' · '));
  }
  return lines.join('\n');
}

/**
 * Run a leading slash command for a messenger message.
 *
 * @param {object} args
 * @param {{ name: string, args: string, body: string }} args.command - parsed result
 * @param {object} args.ctx - { type, token, channelId, threadId, sourceMessageId }
 * @param {{
 *   listProviders: () => Promise<Array<{ id, name, models: Array<{ id, name }> }>>,
 *   listAgents: () => Promise<Array<{ name, description?, model?, hidden? }>>,
 *   listSessions: (directory?: string) => Promise<Array<any>>,
 *   abortSession: (sessionId: string, directory?: string) => Promise<{ ok, error? }>,
 *   revertSession: (sessionId: string, messageId?: string) => Promise<{ ok, error? }>,
 *   unrevertSession: (sessionId: string) => Promise<{ ok, error? }>,
 *   summarizeSession: (sessionId: string, modelRef: string) => Promise<{ ok, error? }>,
 *   sendOpencodeCommand: (sessionId: string, name: string, argumentsText: string) => Promise<{ ok, error? }>,
 *   sendPrompt: (sessionId: string, projectPath: string | null, text: string) => Promise<{ ok, error? }>,
 * }} args.opencode - small adapter passed in by the bridge
 * @param {object} args.binding - current binding for this surface
 *   { sessionId?, projectPath?, projectLabel?, modelOverride?, agentOverride? }
 * @param {{
 *   setOverrides: (changes: { modelOverride?: string|null, agentOverride?: string|null }) => Promise<void>,
 *   unbindSession: () => Promise<void>,
 * }} args.surfaceMutators
 * @returns {Promise<null | { reply: string }>} - null means "not a command, pass through".
 */
export async function executeMessengerCommand({
  command,
  ctx,
  opencode,
  binding,
  surfaceMutators,
  bridgeOps = null,
}) {
  if (!command || !KNOWN_TOP_LEVEL.has(command.name)) {
    // Pass through — let OpenCode itself decide (e.g. user-defined `/changelog`).
    // We return null so the bridge forwards as a prompt; OpenCode's
    // session.command machinery handles registered custom commands when the
    // text starts with /name on its own line.
    return null;
  }

  const cmd = COMMAND_ALIASES.get(command.name) ?? command.name;
  const sessionId = binding?.sessionId ?? null;

  switch (cmd) {
    case 'help': {
      const lines = ['**OpenChamber agent messenger commands**', ''];
      for (const c of COMMAND_HELP) lines.push(`\`${c.usage}\` — ${c.summary}`);
      lines.push('');
      lines.push(
        'Free text is sent to OpenCode as a normal chat prompt. The mapped project, model and agent are picked from the channel/thread automatically.',
      );
      return { reply: lines.join('\n') };
    }

    case 'status': {
      const lines = ['**OpenChamber agent status**'];
      lines.push(
        `Project: ${binding?.projectLabel ?? binding?.projectPath ?? '_not bound — reply `clone <url>`, `path </abs>` or `new <name>` to set up_'}`,
      );
      lines.push(`Session: ${sessionId ? `\`${sessionId}\`` : '_none yet — first prompt creates one_'}`);
      const surfaceModel = binding?.modelOverride;
      const projectModel = binding?.projectDefaults?.modelDefault;
      const globalModel = binding?.globalDefaultModel;
      lines.push(
        `Model: ${
          surfaceModel
            ? `\`${surfaceModel}\` _(this conversation)_`
            : projectModel
              ? `\`${projectModel}\` _(project default)_`
              : globalModel
                ? `\`${globalModel}\` _(OpenChamber default)_`
                : '_OpenCode default_'
        }`,
      );
      const surfaceAgent = binding?.agentOverride;
      const projectAgent = binding?.projectDefaults?.agentDefault;
      const globalAgent = binding?.globalDefaultAgent;
      lines.push(
        `Agent: ${
          surfaceAgent
            ? `\`${surfaceAgent}\` _(this conversation)_`
            : projectAgent
              ? `\`${projectAgent}\` _(project default)_`
              : globalAgent
                ? `\`${globalAgent}\` _(OpenChamber default)_`
                : '_OpenCode default_'
        }`,
      );
      lines.push(`Surface: ${ctx.type} · channel \`${ctx.channelId}\`${ctx.threadId ? ` thread \`${ctx.threadId}\`` : ''}`);
      return { reply: lines.join('\n') };
    }

    case 'add-project': {
      if (!bridgeOps?.addProject) {
        return { reply: '✗ `/add-project` is not available on this surface.' };
      }
      const [pathArg, ...labelParts] = command.args.trim().split(/\s+/);
      if (!pathArg) {
        return { reply: '✗ Usage: `/add-project <absolute-path> [label]`.' };
      }
      const r = await bridgeOps.addProject({ path: pathArg, label: labelParts.join(' ').trim() || null });
      if (!r.ok) return { reply: `✗ Could not add project: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          `✓ Project bound: *${r.project.label ?? r.project.path}*`,
          `📁 \`${r.project.path}\``,
          r.discord?.ok && r.discord.channelId
            ? `Discord channel: <#${r.discord.channelId}>${r.discord.created ? ' _(created)_' : ' _(reused)_'}`
            : `Discord channel: ${r.discord?.error ?? 'not configured'}`,
        ].join('\n'),
      };
    }

    case 'create-new-project': {
      if (!bridgeOps?.createNewProject) {
        return { reply: '✗ `/create-new-project` is not available on this surface.' };
      }
      const raw = command.args.trim();
      if (!raw) {
        return { reply: '✗ Usage: `/create-new-project <name-or-absolute-path>`.' };
      }
      const r = await bridgeOps.createNewProject({ value: raw });
      if (!r.ok) return { reply: `✗ Could not create project: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          `✓ Project created and bound: *${r.project.label ?? r.project.path}*`,
          `📁 \`${r.project.path}\``,
          r.discord?.ok && r.discord.channelId
            ? `Discord channel: <#${r.discord.channelId}>${r.discord.created ? ' _(created)_' : ' _(reused)_'}`
            : `Discord channel: ${r.discord?.error ?? 'not configured'}`,
        ].join('\n'),
      };
    }

    case 'remove-project': {
      if (!bridgeOps?.removeProjectBinding) {
        return { reply: '✗ `/remove-project` is not available on this surface.' };
      }
      const r = await bridgeOps.removeProjectBinding();
      if (!r.ok) return { reply: `✗ Could not remove project binding: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          '✓ Project binding removed for this Discord channel.',
          r.projectPath ? `Files were not deleted: \`${r.projectPath}\`.` : 'No project files were touched.',
          r.channelId ? `Discord channel <#${r.channelId}> was not deleted.` : 'Discord history was not deleted.',
        ].join('\n'),
      };
    }

    case 'abort': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const r = await opencode.abortSession(sessionId, binding?.projectPath ?? undefined);
      if (r.ok) {
        bridgeOps?.markSessionAborted?.(sessionId);
      }
      // Aborting clears any queued messages for the surface.
      let clearedNote = '';
      if (r.ok && bridgeOps?.clearQueue) {
        const cleared = await bridgeOps.clearQueue().catch(() => 0);
        if (cleared > 0) clearedNote = ` Cleared ${cleared} queued message${cleared === 1 ? '' : 's'}.`;
      }
      return { reply: r.ok ? `🛑 Aborted session \`${sessionId}\`.${clearedNote}` : `✗ Could not abort: ${r.error ?? 'unknown error'}` };
    }

    case 'new': {
      await surfaceMutators.unbindSession();
      return {
        reply:
          '✓ Session cleared. The next message you send will start a fresh OpenCode session in the same project.',
      };
    }

    case 'undo': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const r = await opencode.revertSession(sessionId);
      return { reply: r.ok ? '✓ Reverted one turn.' : `✗ Revert failed: ${r.error ?? 'unknown error'}` };
    }

    case 'redo': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const r = await opencode.unrevertSession(sessionId);
      return { reply: r.ok ? '✓ Stepped forward.' : `✗ Redo failed: ${r.error ?? 'unknown error'}` };
    }

    case 'compact': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const modelRef = binding?.modelOverride ?? '';
      const r = await opencode.summarizeSession(sessionId, modelRef);
      return {
        reply: r.ok
          ? '✓ Compaction requested. The next assistant turn will run on the compacted context.'
          : `✗ Compaction failed: ${r.error ?? 'unknown error'}`,
      };
    }

    case 'summary': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const topic = command.args.trim();
      const synthetic =
        topic.length > 0
          ? `Please write a short markdown summary of this session focused on: ${topic}. Mention unrelated threads only briefly.`
          : 'Please write a short markdown summary of this session: key requests, decisions, files touched, and open follow-ups.';
      const r = await opencode.sendPrompt(sessionId, binding?.projectPath ?? null, synthetic);
      return {
        reply: r.ok
          ? '⏳ Summary requested — OpenChamber agent is writing it now.'
          : `✗ Could not request summary: ${r.error ?? 'unknown error'}`,
      };
    }

    case 'init':
    case 'review': {
      if (!sessionId) {
        return { reply: `✗ Send a regular message first so I can spin up a session, then \`/${cmd}\`.` };
      }
      const r = await opencode.sendOpencodeCommand(sessionId, cmd, command.args + (command.body ? `\n${command.body}` : ''));
      return {
        reply: r.ok
          ? `⏳ Running \`/${cmd}\` against the current session…`
          : `✗ \`/${cmd}\` failed: ${r.error ?? 'unknown error'}`,
      };
    }

    case 'diff': {
      if (!bridgeOps?.gitDiff) {
        return { reply: '✗ `/diff` is not available on this surface.' };
      }
      const r = await bridgeOps.gitDiff();
      return { reply: r.ok ? r.reply : `✗ Diff failed: ${r.error ?? 'unknown error'}` };
    }

    case 'tunnel': {
      if (!bridgeOps?.startTunnel) {
        return { reply: '✗ `/tunnel` is not available on this surface.' };
      }
      const r = await bridgeOps.startTunnel({ args: command.args.trim() });
      if (!r.ok) return { reply: `✗ Tunnel failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          '🔗 **OpenChamber tunnel is live**',
          r.publicUrl ? `${r.publicUrl}` : null,
          r.provider ? `Provider: \`${r.provider}\`${r.mode ? ` · mode \`${r.mode}\`` : ''}` : null,
          r.note ?? null,
        ].filter(Boolean).join('\n'),
      };
    }

    case 'login': {
      if (!bridgeOps?.loginInfo) {
        return { reply: '✗ `/login` is not available on this surface.' };
      }
      const r = await bridgeOps.loginInfo({ provider: command.args.trim() || null });
      return { reply: r.ok ? r.reply : `✗ Login setup failed: ${r.error ?? 'unknown error'}` };
    }

    case 'usage': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      if (!bridgeOps?.usageSummary) {
        return { reply: '✗ `/usage` is not available on this surface.' };
      }
      const r = await bridgeOps.usageSummary();
      return { reply: r.ok ? r.reply : `✗ Usage unavailable: ${r.error ?? 'unknown error'}` };
    }

    case 'shell': {
      const cmdText = [command.args, command.body].filter(Boolean).join('\n').trim();
      if (!cmdText) {
        return { reply: '✗ Usage: `/shell <command>` — e.g. `/shell pwd`.' };
      }
      if (!bridgeOps?.runShell) {
        return { reply: '✗ `/shell` is not available on this surface.' };
      }
      // No active session is required — runShell auto-creates one (resolving the
      // project) so a shell command works without sending a chat message first.
      const r = await bridgeOps.runShell({ command: cmdText });
      if (!r.ok) return { reply: `✗ Shell command failed: ${r.error ?? 'unknown error'}` };
      // The command + output are mirrored back as a dedicated shell block once
      // OpenCode finishes running it (see renderUserShellResult in the bridge);
      // this is just the immediate "it's running" acknowledgement.
      return { reply: `⬦ Running \`${cmdText.split('\n')[0].replace(/`/g, "'").slice(0, 150)}\`…` };
    }

    case 'model': {
      if (!command.args) {
        const providers = await opencode.listProviders().catch(() => []);
        if (!providers || providers.length === 0) {
          return { reply: '_(no providers configured — see Settings → Providers in the web UI.)_' };
        }
        const lines = [
          '**Available models** — set with `/model provider/model` (this conversation) or `/model default provider/model` (project-wide)',
          '',
        ];
        for (const p of providers.slice(0, 12)) {
          const ms = (p.models ?? []).slice(0, 8).map((m) => `\`${p.id}/${m.id}\``).join(' · ');
          lines.push(`**${p.name ?? p.id}** — ${ms || '_no models_'}`);
        }
        if (binding?.modelOverride) {
          lines.push('', `Surface override: \`${binding.modelOverride}\``);
        }
        if (binding?.projectDefaults?.modelDefault) {
          lines.push(`Project default: \`${binding.projectDefaults.modelDefault}\``);
        }
        if (binding?.globalDefaultModel) {
          lines.push(`OpenChamber default: \`${binding.globalDefaultModel}\``);
        }
        if (
          !binding?.modelOverride &&
          !binding?.projectDefaults?.modelDefault &&
          !binding?.globalDefaultModel
        ) {
          lines.push('', '_No default set — OpenCode picks the model. Set one above or in Settings → Defaults._');
        }
        return { reply: lines.join('\n') };
      }
      const raw = command.args.trim();
      const defaultMatch = raw.match(/^default\s+(.+)$/i);
      if (defaultMatch) {
        const value = defaultMatch[1].trim();
        if (!binding?.projectPath) {
          return {
            reply:
              '✗ This conversation has no project bound yet. Send a regular message first (or run the bootstrap dialogue) before setting project defaults.',
          };
        }
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setProjectDefaults({ modelDefault: null, variantDefault: null });
          return {
            reply: `✓ Project default model cleared for *${binding.projectLabel ?? binding.projectPath}*.`,
          };
        }
        if (!/^[^/]+\/[^/]+$/.test(value)) {
          return {
            reply:
              '✗ Use `/model default provider/model` (e.g. `/model default anthropic/claude-sonnet-4`).',
          };
        }
        // A new model invalidates any saved thinking-effort (variants are
        // model-specific), so clear it; the `/model` wizard re-sets effort.
        await surfaceMutators.setProjectDefaults({ modelDefault: value, variantDefault: null });
        return {
          reply: `✓ Project default model set to \`${value}\` for *${binding.projectLabel ?? binding.projectPath}*. Every Discord session in this project uses it unless overridden.`,
        };
      }
      if (raw === 'reset' || raw === 'clear') {
        await surfaceMutators.setOverrides({ modelOverride: null, variantOverride: null });
        return { reply: '✓ Surface model override cleared — falling back to project default / OpenCode default.' };
      }
      if (!/^[^/]+\/[^/]+$/.test(raw)) {
        return {
          reply:
            '✗ Use `/model provider/model` (e.g. `/model anthropic/claude-sonnet-4`), or `/model default provider/model` for project-wide. Run `/model` with no args to see the list. Use `/model` on Discord to also pick a thinking effort.',
        };
      }
      // A new model invalidates any saved thinking-effort (variants are
      // model-specific). The Discord `/model` wizard re-applies effort.
      await surfaceMutators.setOverrides({ modelOverride: raw, variantOverride: null });
      return { reply: `✓ Model set to \`${raw}\` for this conversation.` };
    }

    case 'agent': {
      if (!command.args) {
        const agents = await opencode.listAgents().catch(() => []);
        const visible = agents.filter((a) => !a.hidden);
        if (visible.length === 0) {
          return { reply: '_(no agents configured — see Settings → Agents in the web UI.)_' };
        }
        const lines = [
          '**Available agents** — set with `/agent name` (this conversation) or `/agent default name` (project-wide)',
          '',
        ];
        for (const a of visible.slice(0, 20)) {
          const tail = [a.model ? `model \`${a.model}\`` : null, a.description ?? null]
            .filter(Boolean)
            .join(' · ');
          lines.push(`\`${a.name}\`${tail ? ` — ${tail}` : ''}`);
        }
        if (binding?.agentOverride) {
          lines.push('', `Surface override: \`${binding.agentOverride}\``);
        }
        if (binding?.projectDefaults?.agentDefault) {
          lines.push(`Project default: \`${binding.projectDefaults.agentDefault}\``);
        }
        return { reply: lines.join('\n') };
      }
      const raw = command.args.trim();
      const defaultMatch = raw.match(/^default\s+(.+)$/i);
      if (defaultMatch) {
        const value = defaultMatch[1].trim();
        if (!binding?.projectPath) {
          return {
            reply:
              '✗ This conversation has no project bound yet. Send a regular message first before setting project defaults.',
          };
        }
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setProjectDefaults({ agentDefault: null });
          return {
            reply: `✓ Project default agent cleared for *${binding.projectLabel ?? binding.projectPath}*.`,
          };
        }
        await surfaceMutators.setProjectDefaults({ agentDefault: value });
        return {
          reply: `✓ Project default agent set to \`${value}\` for *${binding.projectLabel ?? binding.projectPath}*.`,
        };
      }
      if (raw === 'reset' || raw === 'clear') {
        await surfaceMutators.setOverrides({ agentOverride: null });
        return { reply: '✓ Surface agent override cleared — falling back to project default / OpenCode default.' };
      }
      await surfaceMutators.setOverrides({ agentOverride: raw });
      return { reply: `✓ Agent set to \`${raw}\` for this conversation.` };
    }

    case 'verbosity': {
      const effective =
        binding?.verbosityOverride ??
        binding?.projectDefaults?.verbosityDefault ??
        binding?.verbosityDefault ??
        'normal';
      if (!command.args) {
        const lines = [
          '**Output verbosity** — how much of each turn OpenChamber agent mirrors back here',
          '',
        ];
        for (const level of VERBOSITY_LEVELS) {
          const marker = level === effective ? '➤ ' : '· ';
          lines.push(`${marker}\`${level}\` — ${VERBOSITY_DESCRIPTIONS[level]}`);
        }
        lines.push('');
        lines.push(
          'Set with `/verbosity verbose` (this conversation), `/verbosity project verbose` (this project) or `/verbosity default verbose` (every channel/chat on this bot). `/verbosity reset` clears the conversation override.',
        );
        if (binding?.verbosityOverride) {
          lines.push('', `Conversation override: \`${binding.verbosityOverride}\``);
        }
        if (binding?.projectDefaults?.verbosityDefault) {
          lines.push(`Project default: \`${binding.projectDefaults.verbosityDefault}\``);
        }
        if (binding?.verbosityDefault) {
          lines.push(`Messenger default: \`${binding.verbosityDefault}\``);
        }
        return { reply: lines.join('\n') };
      }

      const raw = command.args.trim();
      const defaultMatch = raw.match(/^default\s+(.+)$/i);
      if (defaultMatch) {
        const value = defaultMatch[1].trim();
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setVerbosityDefault(null);
          return { reply: '✓ Messenger default verbosity cleared — falling back to `normal`.' };
        }
        const level = parseVerbosityLevel(value);
        if (!level) {
          return {
            reply: `✗ Unknown level. Use one of: ${VERBOSITY_LEVELS.map((l) => `\`${l}\``).join(', ')}.`,
          };
        }
        await surfaceMutators.setVerbosityDefault(level);
        return {
          reply: `✓ Messenger default verbosity set to \`${level}\` — ${VERBOSITY_DESCRIPTIONS[level]}.`,
        };
      }

      const projectMatch = raw.match(/^project\s+(.+)$/i);
      if (projectMatch) {
        const value = projectMatch[1].trim();
        if (!binding?.projectPath) {
          return {
            reply:
              '✗ This conversation has no project bound yet. Send a regular message first before setting project defaults.',
          };
        }
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setProjectDefaults({ verbosityDefault: null });
          return {
            reply: `✓ Project default verbosity cleared for *${binding.projectLabel ?? binding.projectPath}*.`,
          };
        }
        const level = parseVerbosityLevel(value);
        if (!level) {
          return {
            reply: `✗ Unknown level. Use one of: ${VERBOSITY_LEVELS.map((l) => `\`${l}\``).join(', ')}.`,
          };
        }
        await surfaceMutators.setProjectDefaults({ verbosityDefault: level });
        return {
          reply: `✓ Project default verbosity set to \`${level}\` for *${binding.projectLabel ?? binding.projectPath}* — ${VERBOSITY_DESCRIPTIONS[level]}.`,
        };
      }

      if (raw === 'reset' || raw === 'clear') {
        await surfaceMutators.setOverrides({ verbosityOverride: null });
        return { reply: '✓ Conversation verbosity override cleared — falling back to the messenger default.' };
      }

      const level = parseVerbosityLevel(raw);
      if (!level) {
        return {
          reply: `✗ Unknown level. Use one of: ${VERBOSITY_LEVELS.map((l) => `\`${l}\``).join(', ')}, or \`/verbosity default <level>\`.`,
        };
      }
      await surfaceMutators.setOverrides({ verbosityOverride: level });
      return {
        reply: `✓ Verbosity set to \`${level}\` for this conversation — ${VERBOSITY_DESCRIPTIONS[level]}.`,
      };
    }

    case 'yolo':
    case 'permissions': {
      const effective =
        binding?.permissionModeOverride ??
        binding?.projectDefaults?.permissionModeDefault ??
        binding?.permissionModeDefault ??
        'ask';
      if (!command.args) {
        const lines = [
          '**Tool permission mode** — how OpenChamber agent handles approval requests (shell, edits, …)',
          '',
        ];
        for (const mode of PERMISSION_MODES) {
          const marker = mode === effective ? '➤ ' : '· ';
          lines.push(`${marker}\`${mode}\` — ${PERMISSION_MODE_DESCRIPTIONS[mode]}`);
        }
        lines.push('');
        lines.push(
          'Set with `/permissions yolo` (this conversation), `/permissions project yolo` (this project) or `/permissions default yolo` (every channel/chat on this bot). `/permissions reset` clears the conversation override. `/yolo` is a synonym. You can always stop a run with `/abort`.',
        );
        if (binding?.permissionModeOverride) {
          lines.push('', `Conversation override: \`${binding.permissionModeOverride}\``);
        }
        if (binding?.projectDefaults?.permissionModeDefault) {
          lines.push(`Project default: \`${binding.projectDefaults.permissionModeDefault}\``);
        }
        if (binding?.permissionModeDefault) {
          lines.push(`Messenger default: \`${binding.permissionModeDefault}\``);
        }
        return { reply: lines.join('\n') };
      }

      const raw = command.args.trim();
      const defaultMatch = raw.match(/^default\s+(.+)$/i);
      if (defaultMatch) {
        const value = defaultMatch[1].trim();
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setPermissionModeDefault(null);
          return { reply: '✓ Messenger default permission mode cleared — falling back to `ask`.' };
        }
        const mode = parsePermissionMode(value);
        if (!mode) {
          return { reply: `✗ Unknown mode. Use one of: ${PERMISSION_MODES.map((m) => `\`${m}\``).join(', ')}.` };
        }
        await surfaceMutators.setPermissionModeDefault(mode);
        return {
          reply: `✓ Messenger default permission mode set to \`${mode}\` (${PERMISSION_MODE_LABELS[mode]}).`,
        };
      }

      const projectMatch = raw.match(/^project\s+(.+)$/i);
      if (projectMatch) {
        const value = projectMatch[1].trim();
        if (!binding?.projectPath) {
          return {
            reply:
              '✗ This conversation has no project bound yet. Send a regular message first before setting project defaults.',
          };
        }
        if (value === 'reset' || value === 'clear') {
          await surfaceMutators.setProjectDefaults({ permissionModeDefault: null });
          return {
            reply: `✓ Project default permission mode cleared for *${binding.projectLabel ?? binding.projectPath}*.`,
          };
        }
        const mode = parsePermissionMode(value);
        if (!mode) {
          return { reply: `✗ Unknown mode. Use one of: ${PERMISSION_MODES.map((m) => `\`${m}\``).join(', ')}.` };
        }
        await surfaceMutators.setProjectDefaults({ permissionModeDefault: mode });
        return {
          reply: `✓ Project default permission mode set to \`${mode}\` for *${binding.projectLabel ?? binding.projectPath}* (${PERMISSION_MODE_LABELS[mode]}).`,
        };
      }

      if (raw === 'reset' || raw === 'clear') {
        await surfaceMutators.setOverrides({ permissionModeOverride: null });
        return { reply: '✓ Conversation permission mode override cleared — falling back to the messenger default.' };
      }

      const mode = parsePermissionMode(raw);
      if (!mode) {
        return {
          reply: `✗ Unknown mode. Use one of: ${PERMISSION_MODES.map((m) => `\`${m}\``).join(', ')}, or \`/permissions default <mode>\`.`,
        };
      }
      await surfaceMutators.setOverrides({ permissionModeOverride: mode });
      return {
        reply: `✓ Permission mode set to \`${mode}\` for this conversation — ${PERMISSION_MODE_DESCRIPTIONS[mode]}.`,
      };
    }

    case 'skill': {
      const projectPath = binding?.projectPath ?? null;
      const skills = await (opencode.listSkills
        ? opencode.listSkills(projectPath)
        : Promise.resolve([])
      ).catch(() => []);
      if (!command.args) {
        if (!skills || skills.length === 0) {
          return {
            reply:
              '_(no skills available for this conversation — install some via the Skills catalog in the web UI.)_',
          };
        }
        const lines = [
          '**Available skills** — hand one to OpenChamber agent with `/skill <name>` (on Discord, `/skill` opens a dropdown)',
          '',
        ];
        for (const s of skills.slice(0, 25)) {
          const desc = (s.description || '').trim();
          lines.push(`\`${s.name}\`${desc ? ` — ${desc}` : ''}`);
        }
        return { reply: lines.join('\n') };
      }
      const wanted = command.args.trim();
      const match =
        skills.find((s) => s.name === wanted) ||
        skills.find((s) => (s.name ?? '').toLowerCase() === wanted.toLowerCase());
      if (!match) {
        return { reply: `✗ Unknown skill \`${wanted}\`. Run \`/skill\` to see what's available.` };
      }
      if (!sessionId) {
        return {
          reply: `✗ Send a regular message first so I can spin up a session, then \`/skill ${match.name}\`.`,
        };
      }
      const desc = (match.description || '').trim();
      const prompt = desc
        ? `Use the "${match.name}" skill for this task.\n\nSkill: ${match.name} — ${desc}`
        : `Use the "${match.name}" skill for this task.`;
      const r = await opencode.sendPrompt(sessionId, projectPath, prompt);
      return {
        reply: r.ok
          ? `▶ Handed the \`${match.name}\` skill to OpenChamber agent.`
          : `✗ Could not run skill: ${r.error ?? 'unknown error'}`,
      };
    }

    case 'sessions': {
      const sessions = await opencode.listSessions(binding?.projectPath ?? null).catch(() => []);
      if (!sessions || sessions.length === 0) {
        return {
          reply: binding?.projectPath
            ? `_(no sessions yet in ${binding.projectPath})_`
            : '_(no sessions found)_',
        };
      }
      const top = sessions.slice(0, 10);
      const lines = [`**Recent sessions** ${binding?.projectLabel ? `(${binding.projectLabel})` : ''}`, ''];
      const rows = top.map((s) => ({
        when: s.time?.updated ? new Date(s.time.updated).toLocaleString() : (s.updatedAt ?? ''),
        id: (s.id ?? s.sessionID ?? '').slice(0, 22),
        title: s.title ?? '(untitled)',
      }));
      lines.push(
        fmtTable(rows, [
          { key: 'when', italic: true },
          { key: 'title' },
          { key: 'id', code: true },
        ]),
      );
      return { reply: lines.join('\n') };
    }

    case 'session': {
      const prompt = [command.args, command.body].filter(Boolean).join('\n').trim();
      if (!prompt) {
        return { reply: '✗ Usage: `/session <prompt>` — e.g. `/session Add user authentication`.' };
      }
      if (!bridgeOps?.startSession) {
        return { reply: '✗ `/session` is not available on this surface.' };
      }
      const r = await bridgeOps.startSession({ prompt });
      return {
        reply: r.ok
          ? `🚀 Starting OpenCode session${r.threadId ? ` in <#${r.threadId}>` : ''}…`
          : `✗ Could not start session: ${r.error ?? 'unknown error'}`,
      };
    }

    case 'resume': {
      if (!bridgeOps?.resumeSession || !bridgeOps?.listResumeCandidates) {
        return { reply: '✗ `/resume` is not available on this surface.' };
      }
      const ref = command.args.trim();
      if (!ref) {
        const candidates = await bridgeOps.listResumeCandidates().catch(() => []);
        if (!candidates || candidates.length === 0) {
          return { reply: '_(no resumable sessions found for this project)_' };
        }
        const lines = ['**Resume a session** — reply `/resume <n>` or `/resume <session-id>`', ''];
        candidates.slice(0, 10).forEach((s, i) => {
          lines.push(`**${i + 1}.** ${s.title ?? '(untitled)'} — _${s.when ?? ''}_ \`${s.id}\``);
        });
        return { reply: lines.join('\n') };
      }
      const r = await bridgeOps.resumeSession({ ref });
      if (!r.ok) return { reply: `✗ Could not resume: ${r.error ?? 'unknown error'}` };
      return {
        reply: `✓ Session resumed${r.title ? `: **${r.title}**` : ''}${r.threadId ? ` — continue in <#${r.threadId}>` : ''}.${r.loadedNote ? ` ${r.loadedNote}` : ''}`,
      };
    }

    case 'fork': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation — nothing to fork.' };
      if (!bridgeOps?.forkSession || !bridgeOps?.listForkCandidates) {
        return { reply: '✗ `/fork` is not available on this surface.' };
      }
      const arg = command.args.trim();
      if (!arg) {
        const candidates = await bridgeOps.listForkCandidates().catch(() => []);
        if (!candidates || candidates.length === 0) {
          return { reply: '_(no user messages found in this session to fork from)_' };
        }
        const lines = ['**Fork this session** — reply `/fork <n>` to branch from that message', ''];
        candidates.slice(0, 25).forEach((m, i) => {
          lines.push(`**${i + 1}.** ${m.preview} — _${m.when ?? ''}_`);
        });
        return { reply: lines.join('\n') };
      }
      const index = Number.parseInt(arg, 10);
      if (!Number.isFinite(index) || index < 1) {
        return { reply: '✗ Usage: `/fork <n>` where `n` comes from the `/fork` list.' };
      }
      const r = await bridgeOps.forkSession({ index });
      if (!r.ok) return { reply: `✗ Fork failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: `✓ Session forked${r.threadId ? ` — continue in <#${r.threadId}>` : ''}. The fork continues as if later messages were never sent.`,
      };
    }

    case 'btw': {
      const text = [command.args, command.body].filter(Boolean).join('\n').trim();
      if (!text) {
        return { reply: '✗ Usage: `/btw <side question>` — e.g. `/btw how should we test this?`.' };
      }
      if (!sessionId) {
        return { reply: '✗ No session is active on this conversation — send a regular message first, then ask a side question with `/btw`.' };
      }
      if (!bridgeOps?.btwQuestion) {
        return { reply: '✗ `/btw` is not available on this surface.' };
      }
      const r = await bridgeOps.btwQuestion({ text });
      if (!r.ok) return { reply: `✗ Could not start side thread: ${r.error ?? 'unknown error'}` };
      return {
        reply: `↪ Side thread started${r.threadId ? ` in <#${r.threadId}>` : ''}. The current run was left alone.`,
      };
    }

    case 'share': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const r = await opencode.shareSession(sessionId, binding?.projectPath ?? undefined);
      if (!r.ok) return { reply: `✗ Share failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: r.url
          ? `🔗 Session shared: ${r.url}\n_Anyone with the link can view the full transcript._`
          : '✓ Session shared, but OpenCode returned no URL.',
      };
    }

    case 'unshare': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      const r = await opencode.unshareSession(sessionId, binding?.projectPath ?? undefined);
      return { reply: r.ok ? '✓ Share link revoked.' : `✗ Unshare failed: ${r.error ?? 'unknown error'}` };
    }

    case 'queue': {
      const text = [command.args, command.body].filter(Boolean).join('\n').trim();
      if (!text) return { reply: '✗ Usage: `/queue <message>`' };
      if (!bridgeOps?.queueMessage) {
        return { reply: '✗ `/queue` is not available on this surface.' };
      }
      const r = await bridgeOps.queueMessage({ text });
      if (!r.ok) return { reply: `✗ Could not queue: ${r.error ?? 'unknown error'}` };
      return {
        reply: r.queued
          ? `✓ Message queued (position: ${r.position}). It will be sent after the current response.`
          : `» Sent immediately — no response is currently running.`,
      };
    }

    case 'clear-queue': {
      if (!bridgeOps?.clearQueue) {
        return { reply: '✗ `/clear-queue` is not available on this surface.' };
      }
      const raw = command.args.trim();
      const position = raw ? Number.parseInt(raw, 10) : null;
      if (raw && (!Number.isFinite(position) || position < 1)) {
        return { reply: '✗ Usage: `/clear-queue [n]` where `n` is a queued message position.' };
      }
      const cleared = await (position ? bridgeOps.clearQueue({ position }) : bridgeOps.clearQueue()).catch(() => 0);
      return {
        reply: cleared > 0
          ? position
            ? `🗑 Cleared queued message ${position}.`
            : `🗑 Cleared ${cleared} queued message${cleared === 1 ? '' : 's'}.`
          : '_(the queue was already empty)_',
      };
    }

    case 'mention-mode': {
      if (!bridgeOps?.toggleMentionMode) {
        return { reply: '✗ `/mention-mode` is not available on this surface.' };
      }
      const enabled = await bridgeOps.toggleMentionMode();
      return {
        reply: enabled
          ? '✓ Mention mode **enabled** — new sessions in this channel now require an @mention of the bot. Existing threads keep working without it.'
          : '✓ Mention mode **disabled** — the bot responds to every message in this channel again.',
      };
    }

    case 'new-worktree': {
      if (!bridgeOps?.newWorktree) {
        return { reply: '✗ `/new-worktree` is not available on this surface.' };
      }
      if (!binding?.projectPath) {
        return { reply: '✗ This channel is not bound to a project yet — send a message first so I can set one up.' };
      }
      const r = await bridgeOps.newWorktree({ name: command.args.trim() || null });
      if (!r.ok) return { reply: `✗ Worktree failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          `🌳 Worktree: \`${r.branch}\``,
          `📁 \`${r.path}\``,
          `🌿 Branch: \`${r.branch}\``,
          r.threadId ? `Continue in <#${r.threadId}> — everything there happens inside the worktree.` : '',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'worktrees': {
      if (!bridgeOps?.listWorktrees) {
        return { reply: '✗ `/worktrees` is not available on this surface.' };
      }
      const r = await bridgeOps.listWorktrees();
      if (!r.ok) return { reply: `✗ Could not list worktrees: ${r.error ?? 'unknown error'}` };
      const rows = (r.worktrees ?? []).map((wt, index) => ({
        n: String(index + 1),
        branch: wt.branch ?? (wt.detached ? '(detached)' : '(unknown)'),
        path: wt.path,
      }));
      if (rows.length === 0) return { reply: '_(no git worktrees found for this project)_' };
      return {
        reply: ['**Project worktrees**', '', fmtTable(rows, [
          { key: 'n' },
          { key: 'branch', code: true },
          { key: 'path', code: true },
        ])].join('\n'),
      };
    }

    case 'toggle-worktrees': {
      if (!bridgeOps?.toggleAutoWorktrees) {
        return { reply: '✗ `/toggle-worktrees` is not available on this surface.' };
      }
      if (!binding?.projectPath) {
        return { reply: '✗ This channel is not bound to a project yet.' };
      }
      const raw = command.args.trim().toLowerCase();
      let enabled = null;
      if (raw) {
        if (['on', 'true', 'yes', 'enable', 'enabled'].includes(raw)) enabled = true;
        else if (['off', 'false', 'no', 'disable', 'disabled'].includes(raw)) enabled = false;
        else return { reply: '✗ Usage: `/toggle-worktrees [on|off]`.' };
      }
      const r = await bridgeOps.toggleAutoWorktrees({ enabled });
      if (!r.ok) return { reply: `✗ Could not update worktree default: ${r.error ?? 'unknown error'}` };
      return {
        reply: r.enabled
          ? '✓ Auto-worktrees **enabled** for this project. New channel sessions can start in isolated worktrees when the bridge creates them.'
          : '✓ Auto-worktrees **disabled** for this project.',
      };
    }

    case 'mcp': {
      if (!bridgeOps?.mcp) {
        return { reply: '✗ `/mcp` is not available on this surface.' };
      }
      const args = command.args.trim();
      if (!args) {
        const r = await bridgeOps.mcp({ action: 'list' });
        if (!r.ok) return { reply: `✗ MCP status unavailable: ${r.error ?? 'unknown error'}` };
        const servers = r.servers ?? [];
        if (servers.length === 0) {
          return { reply: '_(no MCP servers configured for this project)_ ' };
        }
        const rows = servers.map((server) => ({
          name: server.name,
          status: server.status ?? 'configured',
          source: server.scope ?? server.source ?? '',
        }));
        return {
          reply: [
            '**MCP servers**',
            '',
            fmtTable(rows, [
              { key: 'name', code: true },
              { key: 'status' },
              { key: 'source', italic: true },
            ]),
            '',
            'Use `/mcp connect <name>` or `/mcp disconnect <name>` to update OpenCode MCP config and refresh. This is not a separate live MCP supervisor.',
          ].join('\n'),
        };
      }
      const match = args.match(/^(connect|disconnect|enable|disable)\s+(.+)$/i);
      if (!match) {
        return { reply: '✗ Usage: `/mcp` or `/mcp connect <server>` / `/mcp disconnect <server>`.' };
      }
      const action = match[1].toLowerCase() === 'enable' ? 'connect'
        : match[1].toLowerCase() === 'disable' ? 'disconnect'
          : match[1].toLowerCase();
      const name = match[2].trim();
      const r = await bridgeOps.mcp({ action, name });
      return {
        reply: r.ok
          ? `✓ MCP server \`${name}\` marked ${action === 'connect' ? 'connected' : 'disconnected'} in OpenCode config and refresh was requested.`
          : `✗ MCP ${action} failed: ${r.error ?? 'unsupported by this OpenCode server'}`,
      };
    }

    case 'context-usage': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      if (!bridgeOps?.contextUsage) {
        return { reply: '✗ `/context-usage` is not available on this surface.' };
      }
      const r = await bridgeOps.contextUsage();
      if (!r.ok) return { reply: `✗ Could not read context usage: ${r.error ?? 'unknown error'}` };
      const percent = r.contextLimit && r.totalTokens
        ? ` (${Math.round((r.totalTokens / r.contextLimit) * 100)}% of context)`
        : '';
      return {
        reply: [
          '**Context usage**',
          `Session: \`${sessionId}\``,
          `Last assistant turn: ${(r.totalTokens ?? 0).toLocaleString()} tokens${percent}`,
          r.contextLimit ? `Context window: ${r.contextLimit.toLocaleString()} tokens` : 'Context window: unknown',
        ].join('\n'),
      };
    }

    case 'session-id': {
      if (!sessionId) return { reply: '✗ No session is active on this conversation.' };
      if (!bridgeOps?.sessionReference) {
        return { reply: `Session id: \`${sessionId}\`` };
      }
      const r = await bridgeOps.sessionReference();
      if (!r.ok) return { reply: `Session id: \`${sessionId}\`\nReference lookup failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: [
          `Session id: \`${r.sessionId}\``,
          r.discordUrl ? `Discord: ${r.discordUrl}` : null,
          `Reference: \`${r.reference ?? r.sessionId}\``,
        ].filter(Boolean).join('\n'),
      };
    }

    case 'schedule': {
      if (!bridgeOps?.scheduleTask || !bridgeOps?.listSchedules || !bridgeOps?.deleteSchedule) {
        return { reply: '✗ `/schedule` is not available on this surface.' };
      }
      const argsText = [command.args, command.body].filter(Boolean).join('\n').trim();

      if (!argsText || argsText === 'list') {
        const tasks = await bridgeOps.listSchedules();
        if (!tasks || tasks.length === 0) {
          return {
            reply: [
              '_(no scheduled tasks in this project)_',
              '',
              'Create one with `/schedule <when> [model=provider/model] [agent=name] <prompt>`:',
              '• one-time (UTC): `/schedule 2026-03-01T09:00 Review open PRs`',
              '• recurring (cron, UTC): `/schedule 0 9 * * 1 Run the weekly test suite`',
              'Tasks live in the project scheduler — view and edit them in the web UI (sidebar → Scheduled tasks) too.',
            ].join('\n'),
          };
        }
        const lines = ['**Scheduled tasks** (project scheduler — also editable in the web UI)', ''];
        for (const t of tasks) {
          const nextRunAt = t.state?.nextRunAt;
          const status = t.enabled
            ? (nextRunAt ? `next ${new Date(nextRunAt).toISOString()}` : 'pending')
            : `disabled${t.state?.lastStatus ? ` (last: ${t.state.lastStatus})` : ''}`;
          lines.push(`\`${t.id}\` — **${t.name}** — ${bridgeOps.describeSchedule ? bridgeOps.describeSchedule(t) : ''} — _${status}_`);
          lines.push(`> ${(t.execution?.prompt ?? '').split('\n')[0].slice(0, 120)}`);
        }
        lines.push('', 'Remove with `/schedule delete <id>`.');
        return { reply: lines.join('\n') };
      }

      const deleteMatch = argsText.match(/^delete\s+(\S+)$/);
      if (deleteMatch) {
        const removed = await bridgeOps.deleteSchedule(deleteMatch[1]);
        return { reply: removed ? `🗑 Deleted scheduled task \`${deleteMatch[1]}\`.` : `✗ No scheduled task \`${deleteMatch[1]}\`.` };
      }

      // Grammar: <when> [model=p/m] [agent=name] <prompt…>
      // <when> is either an ISO-UTC token or a 5-field cron expression.
      const tokens = argsText.split(/\s+/);
      let when = tokens.shift() ?? '';
      if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) {
        // Assume cron: consume up to 5 fields while they look cron-ish.
        const cronFields = [when];
        while (cronFields.length < 5 && tokens.length > 0 && /^[\d*,/\-A-Za-z]+$/.test(tokens[0]) && !tokens[0].includes('=')) {
          cronFields.push(tokens.shift());
        }
        if (cronFields.length === 5) when = cronFields.join(' ');
        else tokens.unshift(...cronFields.slice(1));
      }
      let model = null;
      let agent = null;
      while (tokens.length > 0 && /^(model|agent)=/.test(tokens[0])) {
        const [key, ...rest] = tokens.shift().split('=');
        if (key === 'model') model = rest.join('=');
        if (key === 'agent') agent = rest.join('=');
      }
      const prompt = tokens.join(' ').trim();
      if (!when || !prompt) {
        return {
          reply: '✗ Usage: `/schedule <when> [model=provider/model] [agent=name] <prompt>` — e.g. `/schedule 0 9 * * 1 model=anthropic/claude-sonnet-4 Run the weekly tests`.',
        };
      }

      const r = await bridgeOps.scheduleTask({ when, prompt, model, agent });
      if (!r.ok) return { reply: `✗ Could not schedule: ${r.error ?? 'unknown error'}` };
      const t = r.task;
      const nextRunAt = t.state?.nextRunAt;
      return {
        reply: [
          `⏰ Scheduled \`${t.id}\` — ${bridgeOps.describeSchedule ? bridgeOps.describeSchedule(t) : ''}`,
          `Model: \`${t.execution.providerID}/${t.execution.modelID}\`${t.execution.agent ? ` · agent \`${t.execution.agent}\`` : ''}`,
          'Each run starts a fresh session in the project; results stream into Discord and the web UI.',
          `Next run: ${nextRunAt ? new Date(nextRunAt).toISOString() : 'n/a'} · manage with \`/schedule list\` / \`/schedule delete ${t.id}\` or the web UI's Scheduled tasks dialog.`,
        ].filter(Boolean).join('\n'),
      };
    }

    case 'queue-command': {
      const raw = [command.args, command.body].filter(Boolean).join('\n').trim();
      if (!raw) return { reply: '✗ Usage: `/queue-command <opencode-command> [args]`.' };
      if (!bridgeOps?.queueCommand) {
        return { reply: '✗ `/queue-command` is not available on this surface.' };
      }
      const normalized = raw.replace(/^\/+/, '').trim();
      const name = normalized.split(/\s+/)[0] ?? '';
      const args = normalized.slice(name.length).trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        return { reply: '✗ Queue only accepts an OpenCode command name, for example `/queue-command review`.' };
      }
      const r = await bridgeOps.queueCommand({ name, args });
      if (!r.ok) return { reply: `✗ Could not queue command: ${r.error ?? 'unknown error'}` };
      return {
        reply: r.queued
          ? `✓ Command queued (position: ${r.position}): \`/${name}${args ? ` ${args}` : ''}\`.`
          : `⏳ Running \`/${name}${args ? ` ${args}` : ''}\` now — no response is currently running.`,
      };
    }

    case 'reload-opencode': {
      if (!bridgeOps?.restartOpencodeServer) {
        return { reply: '✗ `/reload-opencode` is not available on this surface.' };
      }
      const r = await bridgeOps.restartOpencodeServer();
      if (!r.ok) return { reply: `✗ Reload/reconnect failed: ${r.error ?? 'unknown error'}` };
      return {
        reply: r.external
          ? '✓ OpenChamber rechecked the external OpenCode server. It cannot kill/restart an external process; restart that server separately if config changes need to load.'
          : '✓ OpenChamber requested an OpenCode reload and reconnected the bridge.',
      };
    }

    case 'merge-worktree': {
      if (!bridgeOps?.mergeWorktree) {
        return { reply: '✗ `/merge-worktree` is not available on this surface.' };
      }
      const r = await bridgeOps.mergeWorktree();
      if (r.ok) return { reply: `✓ ${r.summary ?? 'Worktree merged.'}` };
      if (r.conflict) {
        return {
          reply: `⚠ Merge conflict detected — ${r.error ?? ''}\n${r.promptSent ? 'I asked the model to resolve the conflicts; once it finishes run `/merge-worktree` again.' : 'Resolve the conflicts, then run `/merge-worktree` again.'}`,
        };
      }
      return { reply: `✗ Merge failed: ${r.error ?? 'unknown error'}` };
    }

    default:
      return null;
  }
}

export { COMMAND_HELP, tokenHash, targetKey };
