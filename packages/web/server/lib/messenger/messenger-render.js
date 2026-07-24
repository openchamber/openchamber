/**
 * Pure rendering of OpenCode message parts into Discord markdown.
 *
 * Kept free of any I/O (no SQLite, no fetch) so it can be unit-tested in
 * isolation and reused by the bridge. `messenger-opencode-bridge.js` owns the
 * streaming/session plumbing and imports the renderers from here.
 *
 * Verbosity (`quiet` | `normal` | `verbose`) controls how much detail is
 * mirrored back — see `messenger-verbosity.js`:
 *   - `quiet`   — final assistant text only
 *   - `normal`  — compact activity feed: tool one-liners (name + short
 *                 summary) and a `thinking…` process marker, no payloads
 *   - `verbose` — everything, formatted for readability: commands and
 *                 outputs in fenced blocks, edits as diffs, reasoning as
 *                 quoted text
 */

import { DEFAULT_VERBOSITY, normalizeVerbosity } from './messenger-verbosity.js';

/**
 * Strip ANSI escape sequences from terminal output.
 *
 * Tools like `eza`, `ls --color`, `git`, and test runners emit SGR colour
 * codes (e.g. `\u001b[1;33m`), cursor moves, and OSC hyperlinks. Discord's
 * plain code fences render none of these, so the raw `[1;33m` / `[0m` noise
 * leaks into the message and makes tool results unreadable. We remove the
 * sequences instead of trying to translate them — the bridge mirrors a clean,
 * plain-text view of the output.
 *
 * Handles CSI sequences (`ESC[…`), OSC sequences (`ESC]…BEL`/`ESC]…ST`),
 * single-character escapes, and orphaned SGR codes whose `ESC` byte was already
 * dropped upstream (the exact `[…m` garbage seen in copied terminal output).
 */
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /[\u001B\u009B][@-Z\\-_]|[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
// Orphaned SGR codes (ESC already stripped) — only the colour/style form `[…m`.
const ANSI_ORPHAN_SGR = /\[[0-9;:]*m/g;

export function stripAnsi(input) {
  if (input == null) return '';
  return String(input)
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ORPHAN_SGR, '');
}

/** Light markdown escaping — keep code-fence + backticks usable. */
export function escapeMd(s) {
  return String(s ?? '').replace(/[*_]/g, (c) => `\\${c}`);
}

export function shortFileName(p) {
  if (!p) return '';
  const last = String(p).split(/[\\/]/).pop();
  return last || String(p);
}

export function clipBlock(s, limit) {
  if (!s) return '';
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

/**
 * OpenCode injects this synthetic USER message whenever a shell command is run
 * directly by the user (the web chat's `!cmd` mode and the messenger `/shell`
 * command both route through `POST /session/:id/shell`). The text itself is an
 * internal marker the agent reads — mirroring it verbatim into Discord just
 * prints "The following tool was executed by the user" noise, so the bridge
 * detects it and renders the command + output instead (see
 * `renderUserShellResult`).
 */
export const USER_SHELL_MARKER = 'The following tool was executed by the user';

export function isUserShellMarkerText(text) {
  return typeof text === 'string' && text.trimStart().startsWith(USER_SHELL_MARKER);
}

/**
 * Render a user-initiated shell command (`/shell` in a messenger, or `!cmd` in
 * the web chat) as a compact Discord block: the command followed by its output.
 *
 * Unlike agent tool activity — which `quiet`/`normal` deliberately hide or
 * compress — a shell command is something the user explicitly asked to run, so
 * the command AND its result are always shown in full regardless of verbosity.
 * The output is ANSI-stripped and fence-escaped so terminal colour codes and
 * stray ``` don't corrupt the Discord code block.
 */
export function renderUserShellResult({ command = '', output = '', status = '' } = {}) {
  const cmd = stripAnsi(command).trim();
  const out = stripAnsi(output)
    .replace(/```/g, "'''")
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const isError = String(status).trim().toLowerCase() === 'error';
  if (!cmd && !out) {
    // Nothing useful to show — surface at least the status so the run isn't silent.
    return isError ? '✗ **shell** — command failed' : null;
  }

  let header = isError ? '✗ **shell**' : '⬦ **shell**';
  const blocks = [];
  if (cmd) {
    if (cmd.includes('\n')) {
      blocks.push('```bash\n' + clipBlock(cmd, 600) + '\n```');
    } else {
      header += ` \`${clipBlock(cmd, 300)}\``;
    }
  }
  if (out) {
    blocks.push('```\n' + clipBlock(out, 1500) + '\n```');
  } else if (isError) {
    blocks.push('_(no output — command failed)_');
  }
  return [header, ...blocks].join('\n');
}

/**
 * Render a PermissionRequest into a rich Discord prompt.
 * Mirrors the same tool-specific context as the web UI's PermissionCard.
 * Returns a plain text + markdown string suitable for an approval message footer.
 */
export function renderPermissionContext(permission) {
  if (!permission || typeof permission !== 'object') return '';
  const tool = String(permission.permission ?? '').toLowerCase();
  const meta = permission.metadata ?? {};

  const getStr = (keys, fallback = '') => {
    for (const key of keys) {
      const val = meta[key];
      if (typeof val === 'string' && val.length > 0) return val;
    }
    return fallback;
  };

  const clip = (s, limit) =>
    s && s.length > limit ? s.slice(0, limit - 1) + '…' : s ?? '';

  switch (tool) {
    case 'bash':
    case 'shell':
    case 'shell_command':
    case 'cmd':
    case 'terminal': {
      const cmd = getStr(['command', 'cmd', 'script']);
      const desc = getStr(['description']);
      if (!cmd && !desc) return '';
      const parts = [];
      if (desc) parts.push(`> *${clip(desc, 200)}*`);
      if (cmd) parts.push('```bash\n' + clip(stripAnsi(cmd), 800) + '\n```');
      return parts.join('\n');
    }
    case 'edit':
    case 'multiedit':
    case 'str_replace':
    case 'str_replace_based_edit_tool':
    case 'apply_patch': {
      const fp = getStr(['path', 'file_path', 'filename', 'filePath', 'file']);
      const oldS = getStr(['old_string', 'oldString', 'changes', 'diff']);
      const newS = getStr(['new_string', 'newString']);
      if (!fp && !oldS && !newS) return '';
      const parts = [];
      if (fp) parts.push(`**File:** \`${fp}\``);
      if (oldS) {
        parts.push('**Replace:**\n```diff\n- ' + clip(oldS, 400) + '\n+ ' + clip(newS || '', 400) + '\n```');
      } else if (newS) {
        parts.push('**New content:**\n```\n' + clip(newS, 600) + '\n```');
      }
      return parts.join('\n');
    }
    case 'write':
    case 'create':
    case 'file_write': {
      const fp = getStr(['path', 'file_path', 'filename', 'filePath', 'file']);
      const content = getStr(['content', 'text', 'data']);
      if (!fp && !content) return '';
      const parts = [];
      if (fp) parts.push(`**File:** \`${fp}\``);
      if (content) parts.push('```\n' + clip(content, 600) + '\n```');
      return parts.join('\n');
    }
    case 'webfetch':
    case 'fetch':
    case 'curl':
    case 'wget': {
      const url = getStr(['url', 'uri', 'endpoint']);
      const method = getStr(['method']) || 'GET';
      if (!url) return '';
      return `**URL:** \`${method.toUpperCase()}\` ${url}`;
    }
    case 'read': {
      const fp = getStr(['filePath', 'file_path', 'path', 'file', 'filename']);
      const dir = getStr(['parentDir', 'parent_dir', 'directory']);
      if (!fp && !dir) return '';
      const parts = [];
      if (fp) parts.push(`**Reading:** \`${fp}\``);
      if (dir) parts.push(`**Directory:** \`${dir}\``);
      return parts.join('\n');
    }
    case 'list':
    case 'ls': {
      const p = getStr(['path', 'directory', 'filePath']);
      return p ? `**Listing:** \`${p}\`` : '';
    }
    case 'glob': {
      const p = getStr(['pattern', 'glob']);
      return p ? `**Pattern:** \`${p}\`` : '';
    }
    case 'grep': {
      const p = getStr(['pattern', 'query']);
      return p ? `**Search:** \`${p}\`` : '';
    }
    case 'external_directory': {
      const fp = getStr(['filepath', 'path', 'directory']);
      const par = getStr(['parentDir', 'parent_dir']);
      const parts = [];
      if (fp) parts.push(`**Path:** \`${fp}\``);
      if (par) parts.push(`**Parent:** \`${par}\``);
      return parts.join('\n');
    }
    case 'task':
    case 'subagent': {
      const desc = getStr(['description', 'prompt']);
      return desc ? `> ${clip(desc, 300)}` : '';
    }
    default: {
      const desc = getStr(['description', 'action', 'operation', 'command']);
      if (desc) return `> *${clip(desc, 300)}*`;
      const keys = Object.keys(meta).filter((k) => !['sessionID', 'id', 'type'].includes(k));
      if (keys.length > 0) {
        const preview = keys.slice(0, 3).map((k) => `${k}: ${stripAnsi(meta[k]).slice(0, 60)}`).join('\n');
        return '```\n' + clip(preview, 400) + '\n```';
      }
      return '';
    }
  }
}

/**
 * Render one question of a question request ("ask" tool) into a Discord
 * message body. The interactive option components (buttons / select menu)
 * are attached by the bridge; this renders only the text part: header and
 * question. Options are NOT repeated in the text — the components already
 * show them, so listing them again read as a duplicated wall of text.
 * The single exception: select menus cap at 25 options, so any overflow
 * options are listed in the text to keep them visible and answerable.
 * Questions are interactive session state, so — like permission prompts —
 * they are rendered at every verbosity level.
 */
export function renderQuestionForMessenger(question, { index = 0, total = 1 } = {}) {
  if (!question || typeof question !== 'object') return null;
  const header = typeof question.header === 'string' ? question.header.trim() : '';
  const text = typeof question.question === 'string' ? question.question.trim() : '';
  if (!header && !text) return null;
  const counter = total > 1 ? ` (${index + 1}/${total})` : '';
  const lines = [`❓ **${escapeMd(header || 'Question')}**${counter}`];
  if (text) lines.push(clipBlock(text, 900));
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length > 25) {
    lines.push('', '_Options beyond the first 25 (not in the menu above):_');
    options.slice(25).forEach((opt, i) => {
      const label = typeof opt?.label === 'string' && opt.label.trim() ? opt.label.trim() : `Option ${i + 26}`;
      const description = typeof opt?.description === 'string' ? opt.description.trim() : '';
      lines.push(
        `\`${i + 26}.\` ${escapeMd(clipBlock(label, 120))}${description ? ` — ${escapeMd(clipBlock(description, 150))}` : ''}`,
      );
    });
  }
  lines.push('', '_Pick an option below or reply with your own answer._');
  return clipBlock(lines.join('\n'), 1900);
}

// ── Todo list rendering (todo.updated events) ──────────────────────────────

const TODO_STATUS_ICONS = {
  completed: '✅',
  in_progress: '🔄',
  pending: '⬜',
  cancelled: '🚫',
};

const TODO_LIST_MAX_ITEMS = 30;
const TODO_PROGRESS_SEGMENTS = 5;

/**
 * Build a compact monospace progress bar (e.g. `▰▰▱▱▱` 40%). Wrapped in a
 * code span so Discord renders it at a fixed width — the surrounding emoji
 * checklist has variable glyph widths, so a plain-text bar would look ragged.
 */
function renderTodoProgressBar(done, total) {
  if (total <= 0) return '';
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * TODO_PROGRESS_SEGMENTS);
  const bar = '▰'.repeat(filled) + '▱'.repeat(TODO_PROGRESS_SEGMENTS - filled);
  return `\`${bar}\` ${Math.round(ratio * 100)}%`;
}

/**
 * Render the agent's todo/plan list (from `todo.updated` events) as a
 * Discord checklist. Returns null when there is nothing to show. Like
 * questions and permissions, the plan is session state the user should
 * always see — it is rendered at every verbosity level.
 *
 * Layout: a header line with a progress bar, a blank separator, then the
 * checklist. Completed/cancelled items are struck through; the single
 * in-progress item is bolded so the current focus stands out at a glance.
 */
export function renderTodoListForMessenger(todos) {
  const list = Array.isArray(todos)
    ? todos.filter((t) => t && typeof t.content === 'string' && t.content.trim())
    : [];
  if (list.length === 0) return null;
  const done = list.filter((t) => t.status === 'completed').length;
  const progress = renderTodoProgressBar(done, list.length);
  const lines = [
    `📋 **Plan** — ${done}/${list.length} done${progress ? `  ${progress}` : ''}`,
    '',
  ];
  for (const todo of list.slice(0, TODO_LIST_MAX_ITEMS)) {
    const icon = TODO_STATUS_ICONS[todo.status] ?? TODO_STATUS_ICONS.pending;
    const label = escapeMd(clipBlock(todo.content.trim().replace(/\s+/g, ' '), 150));
    let formatted;
    if (todo.status === 'completed' || todo.status === 'cancelled') {
      formatted = `~~${label}~~`;
    } else if (todo.status === 'in_progress') {
      formatted = `**${label}**`;
    } else {
      formatted = label;
    }
    lines.push(`${icon} ${formatted}`);
  }
  if (list.length > TODO_LIST_MAX_ITEMS) {
    lines.push(`… ${list.length - TODO_LIST_MAX_ITEMS} more`);
  }
  return clipBlock(lines.join('\n'), 1900);
}

/** The compact "the model is thinking" process marker used at `normal`. */
export const THINKING_MARKER = '┣ _thinking…_';

/**
 * Render an OpenCode message part for a Discord surface. Returns
 * `null` when nothing should be posted (e.g. empty text, pending tools).
 *
 * `verbosity` controls how much detail is mirrored:
 *   - `quiet`   — only assistant text (reasoning/tool parts return null here)
 *   - `normal`  — tool one-liners (name + short summary, errors inline) and a
 *                 `thinking…` marker without the reasoning text
 *   - `verbose` — full detail, formatted for readability: reasoning as quoted
 *                 text, commands/diffs/outputs in fenced blocks
 */
export function renderPartForMessenger(part, verbosity = DEFAULT_VERBOSITY) {
  if (!part || typeof part !== 'object') return null;
  const level = normalizeVerbosity(verbosity);

  if (part.type === 'reasoning') {
    if (level === 'quiet') return null;
    if (!part.text || !String(part.text).trim()) return null;
    if (level === 'normal') {
      // Process indicator only — the thought content stays private at normal.
      return THINKING_MARKER;
    }
    // verbose: the actual thoughts, quoted so they read as an aside.
    const text = clipBlock(String(part.text).trim(), 1200);
    const quoted = text
      .split('\n')
      .map((line) => `> ${escapeMd(line)}`)
      .join('\n');
    return `┣ **thinking**\n${quoted}`;
  }

  if (part.type === 'text') {
    const text = typeof part.text === 'string' ? part.text : '';
    if (!text.trim()) return null;
    // We only render text when streaming has settled (part.time.end set).
    // The caller guards this; here we just format.
    return text;
  }

  if (part.type === 'tool') {
    if (level === 'quiet') return null;
    return renderToolPart(part, level);
  }

  return null;
}

export function renderToolPart(part, verbosity = DEFAULT_VERBOSITY) {
  const tool = String(part.tool ?? 'tool');
  const status = part.state?.status ?? 'running';
  const input = part.state?.input ?? {};

  // Tool title — usually a one-word context (e.g. "build", "test").
  // Bash/shell already embed the command in `summary`; OpenCode often sets
  // state.title to the same command string, which would duplicate it in the
  // Discord one-liner at `normal` verbosity.
  const title = typeof part.state?.title === 'string' ? part.state.title : '';
  const titlePart =
    tool === 'bash' || tool === 'shell'
      ? ''
      : title
        ? ` _${escapeMd(title)}_`
        : '';

  const summary = (() => {
    switch (tool) {
      case 'read': {
        const file = shortFileName(input.filePath);
        return file ? `*${escapeMd(file)}*` : '';
      }
      case 'edit':
      case 'multiedit':
      case 'apply_patch': {
        const file = shortFileName(input.filePath);
        const oldStr = typeof input.oldString === 'string' ? input.oldString : '';
        const newStr = typeof input.newString === 'string' ? input.newString : '';
        const removed = oldStr ? oldStr.split('\n').length : 0;
        const added = newStr ? newStr.split('\n').length : 0;
        const delta = added || removed ? ` (+${added}-${removed})` : '';
        return file ? `*${escapeMd(file)}*${delta}` : delta.trim();
      }
      case 'write': {
        const file = shortFileName(input.filePath);
        return file ? `*${escapeMd(file)}*` : '';
      }
      case 'bash':
      case 'shell': {
        const cmd = stripAnsi(input.command).split('\n')[0];
        return cmd ? `\`${clipBlock(cmd, 150)}\`` : '';
      }
      case 'glob': {
        const pattern = input.pattern ?? '';
        const count = part.state?.metadata?.count;
        return `\`${clipBlock(pattern, 80)}\`${typeof count === 'number' ? ` (${count} match${count === 1 ? '' : 'es'})` : ''}`;
      }
      case 'grep': {
        const pattern = input.pattern ?? '';
        const count = part.state?.metadata?.count;
        return `\`${clipBlock(pattern, 80)}\`${typeof count === 'number' ? ` (${count} hit${count === 1 ? '' : 's'})` : ''}`;
      }
      case 'list':
      case 'ls': {
        const path = input.path ?? '';
        return path ? `*${escapeMd(shortFileName(path))}*` : '';
      }
      case 'webfetch':
      case 'fetch': {
        return input.url ? `<${input.url}>` : '';
      }
      case 'task':
      case 'subagent': {
        const desc = input.description ?? input.prompt ?? '';
        return desc ? `_${escapeMd(clipBlock(desc, 100))}_` : '';
      }
      case 'todowrite':
      case 'todoread': {
        const count = Array.isArray(input.todos) ? input.todos.length : null;
        return count != null ? `(${count} todo${count === 1 ? '' : 's'})` : '';
      }
      case 'question': {
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const first = typeof questions[0]?.question === 'string' ? questions[0].question.trim() : '';
        return first ? `_${escapeMd(clipBlock(first, 120))}_` : '';
      }
      default: {
        // Unknown tool — show the first useful input string field.
        const candidate =
          input.filePath ?? input.path ?? input.command ?? input.url ?? input.query ?? '';
        if (typeof candidate === 'string' && candidate.length > 0) {
          return `*${escapeMd(shortFileName(candidate))}*`;
        }
        return '';
      }
    }
  })();

  let icon = '┣';
  if (status === 'error') icon = '✗';
  else if (tool === 'edit' || tool === 'write' || tool === 'multiedit' || tool === 'apply_patch') {
    icon = '◼︎';
  } else if (tool === 'bash' || tool === 'shell') {
    icon = '⬦';
  } else if (tool === 'read') {
    icon = '📖';
  }

  let line = `${icon} **${tool}**${titlePart}`;
  if (summary) line += ` ${summary}`;
  if (status === 'error') {
    const errMsg = part.state?.error ?? '';
    if (errMsg) line += ` — ${escapeMd(clipBlock(String(errMsg), 200))}`;
  }

  // `normal` stops at the one-liner: just the tool name + compact summary.
  // `verbose` appends a readable, tool-specific detail block.
  const level = normalizeVerbosity(verbosity);
  if (level !== 'verbose') return line;

  const detail = renderToolDetailVerbose(part);
  if (detail) line += `\n${detail}`;
  return line;
}

/**
 * Prepare arbitrary tool text for a ```fenced``` block:
 *   - strip ANSI colour/escape noise (Discord renders none of it)
 *   - neutralise embedded code fences so the block can't close early
 *   - drop trailing whitespace and collapse long blank-line runs that
 *     terminal output leaves behind, so results don't waste vertical space
 *   - clip to the per-block limit
 */
function fenceSafe(raw, limit) {
  const cleaned = stripAnsi(raw)
    .replace(/```/g, "'''")
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clipBlock(cleaned, limit);
}

function fence(raw, { lang = '', limit = 700 } = {}) {
  const safe = fenceSafe(raw, limit);
  if (!safe) return '';
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

/** Render a readable diff block from an edit tool's old/new strings. */
function renderEditDiff(input, { maxLinesPerSide = 12, lineLimit = 120 } = {}) {
  const oldStr = typeof input.oldString === 'string' ? input.oldString : '';
  const newStr = typeof input.newString === 'string' ? input.newString : '';
  if (!oldStr && !newStr) return '';
  const sideLines = (s, prefix) => {
    const lines = s ? stripAnsi(s).replace(/```/g, "'''").split('\n') : [];
    const shown = lines.slice(0, maxLinesPerSide).map((l) => `${prefix} ${clipBlock(l, lineLimit)}`);
    if (lines.length > maxLinesPerSide) shown.push(`${prefix} … (${lines.length - maxLinesPerSide} more lines)`);
    return shown;
  };
  const body = [...sideLines(oldStr, '-'), ...sideLines(newStr, '+')].join('\n');
  return body ? `\`\`\`diff\n${body}\n\`\`\`` : '';
}

/**
 * Tool-specific detail rendering for `verbose` — formatted for readability
 * instead of a raw `input:/output:` JSON dump:
 *   - bash/shell  → command in a ```bash``` block, output in a plain block
 *   - edit family → a real ```diff``` block (- old / + new)
 *   - write       → the new file content (clipped)
 *   - read/search → a short output preview
 *   - other tools → pretty-printed input JSON + output preview
 * Errors always close the block with a ⚠ fenced message.
 */
export function renderToolDetailVerbose(part) {
  const tool = String(part.tool ?? 'tool');
  const state = part.state ?? {};
  const input = state.input ?? {};
  const output = typeof state.output === 'string' ? stripAnsi(state.output).trim() : '';
  const blocks = [];

  switch (tool) {
    case 'bash':
    case 'shell': {
      // The one-liner summary already shows single-line commands; only
      // fence the command when it spans multiple lines.
      const cmd = stripAnsi(input.command);
      if (cmd.includes('\n')) blocks.push(fence(cmd, { lang: 'bash', limit: 600 }));
      if (output) blocks.push(fence(output, { limit: 700 }));
      break;
    }
    case 'edit':
    case 'multiedit':
    case 'apply_patch': {
      const diff = renderEditDiff(input);
      if (diff) blocks.push(diff);
      break;
    }
    case 'write': {
      const content = typeof input.content === 'string' ? input.content : '';
      if (content) blocks.push(fence(content, { limit: 500 }));
      break;
    }
    case 'read':
    case 'list':
    case 'ls':
    case 'glob':
    case 'grep':
    case 'webfetch':
    case 'fetch': {
      // Search/read results: a short preview keeps the thread readable.
      if (output) blocks.push(fence(output, { limit: 350 }));
      break;
    }
    case 'task':
    case 'subagent':
    case 'todowrite':
    case 'todoread':
      // Subtasks stream their own parts; todo lists are summarised already.
      break;
    default: {
      if (input && typeof input === 'object' && Object.keys(input).length > 0) {
        let json;
        try {
          json = JSON.stringify(input, null, 2);
        } catch {
          json = String(input);
        }
        blocks.push(fence(json, { lang: 'json', limit: 500 }));
      }
      if (output) blocks.push(fence(output, { limit: 600 }));
      break;
    }
  }

  if (state.status === 'error' && state.error) {
    blocks.push(`⚠ **error**\n${fence(String(state.error), { limit: 400 })}`);
  }

  return blocks.filter(Boolean).join('\n');
}

// ── Token accounting for the session.idle footer ───────────────────────────

/**
 * Context usage for a single assistant turn. Prefers OpenCode's own
 * `tokens.total`; falls back to input + output + reasoning + cache.read +
 * cache.write (the same formula the web UI's getContextUsage uses).
 * Returns 0 for missing/empty token info.
 */
export function computeTurnTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  if (typeof tokens.total === 'number' && tokens.total > 0) return tokens.total;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  );
}

/**
 * Find the LAST assistant message with non-zero token info and return its
 * tokens. This is the true context size of the most recent turn.
 *
 * The session object's own `tokens` field is a CUMULATIVE sum across every
 * assistant turn (each turn re-adds the full cached context), so using it
 * inflates counts severalfold on multi-turn sessions — never use it for
 * context percentages.
 *
 * Accepts both message shapes: `{ info: { role, tokens } }` and flat
 * `{ role, tokens }`.
 */
export function extractLastAssistantTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const info = list[i]?.info ?? list[i];
    if (!info || info.role !== 'assistant') continue;
    const tokens = info.tokens;
    if (computeTurnTokens(tokens) > 0) return tokens;
  }
  return null;
}

// ── Thread naming from OpenCode session titles ─────────────────────────────

const DISCORD_THREAD_NAME_MAX = 100;

/** Thread-name prefixes that must survive a rename (worktree marker etc.). */
const PRESERVED_THREAD_PREFIXES = ['⬦ ', 'Fork: ', 'Resume: '];

/**
 * Decide whether (and how) to rename a Discord thread based on an OpenCode
 * session title. Rules:
 *   - skip empty titles and OpenCode's "New session - …" placeholder
 *   - preserve a recognised prefix from the current thread name
 *   - cap at Discord's 100-char thread-name limit
 *   - return undefined when nothing should change
 */
export function deriveThreadNameFromSessionTitle({ sessionTitle, currentName }) {
  const trimmed = typeof sessionTitle === 'string' ? sessionTitle.trim() : '';
  if (!trimmed) {
    return undefined;
  }
  if (/^new session\s*-/i.test(trimmed)) {
    return undefined;
  }
  const current = typeof currentName === 'string' ? currentName : '';
  const matchedPrefix = PRESERVED_THREAD_PREFIXES.find((p) => current.startsWith(p)) ?? '';
  const candidate = `${matchedPrefix}${trimmed}`.slice(0, DISCORD_THREAD_NAME_MAX);
  if (candidate === current) {
    return undefined;
  }
  return candidate;
}
