import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  confirm as clackConfirm,
  text as clackText,
  isCancel,
  isJsonMode,
  isQuietMode,
  canPrompt,
  printJson,
  logStatus,
} from '../cli-output.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { apiRequest, resolveTargetPort, resolveScopeDirectory } from './cli-api-client.js';
import { truncate, formatRelativeTime, formatModel } from './cli-format.js';

// Session creation and initial-prompt dispatch are intentionally NOT exposed
// here. OpenChamber-owned session orchestration lives behind
// /api/openchamber/sessions (separate work) and is the source of truth for
// creating sessions and optionally dispatching the first prompt. These CLI
// commands only read and mutate existing sessions.
const SESSION_ACTIONS = ['list', 'show', 'rename', 'archive', 'unarchive', 'share', 'unshare', 'delete'];

function isArchived(session) {
  const archived = session?.time?.archived;
  return Number.isFinite(archived) && archived > 0;
}

function requireSessionId(args, options) {
  const id = typeof args[0] === 'string' ? args[0].trim() : '';
  if (id) return id;
  if (typeof options.name === 'string' && options.name.trim().length > 0) return options.name.trim();
  throw new TunnelCliError('A session id is required. Usage: openchamber session <action> <session-id>', EXIT_CODE.USAGE_ERROR);
}

function serializeSession(session) {
  return {
    id: session.id,
    title: session.title || '',
    slug: session.slug,
    directory: session.directory,
    agent: session.agent,
    model: session.model || null,
    archived: isArchived(session),
    shareUrl: session?.share?.url || null,
    created: session?.time?.created ?? null,
    updated: session?.time?.updated ?? null,
  };
}

async function listSessions(port, directory, options) {
  const sessions = await apiRequest(port, 'GET', '/api/session', {
    query: { directory },
    options,
  });
  const all = Array.isArray(sessions) ? sessions : [];
  const includeArchived = Boolean(options.all);
  const filtered = includeArchived ? all : all.filter((session) => !isArchived(session));
  filtered.sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0));
  return filtered;
}

async function handleList(port, directory, options) {
  const sessions = await listSessions(port, directory, options);

  if (isJsonMode(options)) {
    printJson({ directory, count: sessions.length, sessions: sessions.map(serializeSession) });
    return;
  }

  if (isQuietMode(options)) {
    for (const session of sessions) {
      process.stdout.write(`${session.id} ${isArchived(session) ? 'archived' : 'active'} ${session.title || '(untitled)'}\n`);
    }
    return;
  }

  clackIntro('OpenChamber Sessions');
  if (sessions.length === 0) {
    logStatus('warning', 'No sessions found', `directory: ${directory}`);
    clackOutro('0 sessions');
    return;
  }
  for (const session of sessions) {
    const detailParts = [];
    if (session.agent) detailParts.push(String(session.agent));
    const model = formatModel(session.model);
    if (model) detailParts.push(model);
    detailParts.push(formatRelativeTime(session?.time?.updated));
    if (isArchived(session)) detailParts.push('archived');
    logStatus('info', `${session.id}  ${truncate(session.title || '(untitled)', 64)}`, detailParts.join(' · '));
  }
  clackOutro(`${sessions.length} session(s) · ${directory}`);
}

async function handleShow(port, directory, options, args) {
  const id = requireSessionId(args, options);
  const session = await apiRequest(port, 'GET', `/api/session/${encodeURIComponent(id)}`, {
    query: { directory },
    options,
  });
  let messageCount = null;
  try {
    const messages = await apiRequest(port, 'GET', `/api/session/${encodeURIComponent(id)}/message`, {
      query: { directory },
      options,
    });
    messageCount = Array.isArray(messages) ? messages.length : null;
  } catch {
    messageCount = null;
  }

  if (isJsonMode(options)) {
    printJson({ session: { ...serializeSession(session), messageCount } });
    return;
  }

  if (isQuietMode(options)) {
    process.stdout.write(`${session.id} ${isArchived(session) ? 'archived' : 'active'} ${session.title || '(untitled)'}\n`);
    return;
  }

  clackIntro('Session Details');
  logStatus('info', session.id, session.title || '(untitled)');
  const lines = [];
  if (session.slug) lines.push(`slug: ${session.slug}`);
  if (session.agent) lines.push(`agent: ${session.agent}`);
  const model = formatModel(session.model);
  if (model) lines.push(`model: ${model}`);
  lines.push(`directory: ${session.directory || directory}`);
  lines.push(`archived: ${isArchived(session) ? 'yes' : 'no'}`);
  if (session?.share?.url) lines.push(`share: ${session.share.url}`);
  if (Number.isFinite(messageCount)) lines.push(`messages: ${messageCount}`);
  if (session?.time?.created) lines.push(`created: ${formatRelativeTime(session.time.created)}`);
  if (session?.time?.updated) lines.push(`updated: ${formatRelativeTime(session.time.updated)}`);
  logStatus('neutral', 'details', lines.join('\n'));
  clackOutro('done');
}

async function handleRename(port, directory, options, args) {
  const id = requireSessionId(args, options);
  let title = args.slice(1).join(' ').trim();
  if (!title && typeof options.title === 'string') title = options.title.trim();
  if (!title) {
    if (canPrompt(options)) {
      const value = await clackText({ message: 'New session title', placeholder: 'Enter a title' });
      if (isCancel(value)) {
        clackCancel('Operation cancelled.');
        throw new TunnelCliError('Cancelled.', 130);
      }
      title = typeof value === 'string' ? value.trim() : '';
    }
  }
  if (!title) {
    throw new TunnelCliError('A new title is required. Usage: openchamber session rename <id> <title> (or --title).', EXIT_CODE.USAGE_ERROR);
  }

  const session = await apiRequest(port, 'PATCH', `/api/session/${encodeURIComponent(id)}`, {
    query: { directory },
    body: { title },
    options,
  });

  if (isJsonMode(options)) {
    printJson({ renamed: true, session: serializeSession(session) });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${id} ${title}\n`);
    return;
  }
  clackIntro('Rename Session');
  logStatus('success', `Renamed ${id}`, `title: ${title}`);
  clackOutro('done');
}

async function handleArchiveToggle(port, directory, options, args, archive) {
  const id = requireSessionId(args, options);
  const session = await apiRequest(port, 'PATCH', `/api/session/${encodeURIComponent(id)}`, {
    query: { directory },
    body: { time: { archived: archive ? Date.now() : 0 } },
    options,
  });
  const verb = archive ? 'Archived' : 'Unarchived';
  if (isJsonMode(options)) {
    printJson({ archived: archive, session: serializeSession(session) });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${id} ${archive ? 'archived' : 'active'}\n`);
    return;
  }
  clackIntro(`${verb} Session`);
  logStatus('success', `${verb} ${id}`);
  clackOutro('done');
}

async function handleShare(port, directory, options, args, share) {
  const id = requireSessionId(args, options);
  if (share) {
    const session = await apiRequest(port, 'POST', `/api/session/${encodeURIComponent(id)}/share`, {
      query: { directory },
      options,
      timeoutMs: 15000,
    });
    const url = session?.share?.url || null;
    if (isJsonMode(options)) {
      printJson({ shared: true, session: serializeSession(session) });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${url || id}\n`);
      return;
    }
    clackIntro('Share Session');
    if (url) {
      logStatus('success', `Shared ${id}`, url);
    } else {
      logStatus('success', `Shared ${id}`);
    }
    clackOutro('done');
    return;
  }

  await apiRequest(port, 'DELETE', `/api/session/${encodeURIComponent(id)}/share`, {
    query: { directory },
    options,
    timeoutMs: 15000,
  });
  if (isJsonMode(options)) {
    printJson({ unshared: true, id });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${id} unshared\n`);
    return;
  }
  clackIntro('Unshare Session');
  logStatus('success', `Unshared ${id}`);
  clackOutro('done');
}

async function handleDelete(port, directory, options, args) {
  const id = requireSessionId(args, options);

  if (!options.force && canPrompt(options)) {
    const confirmed = await clackConfirm({ message: `Delete session ${id}? This cannot be undone.` });
    if (isCancel(confirmed) || confirmed !== true) {
      clackCancel('Operation cancelled.');
      throw new TunnelCliError('Cancelled.', 130);
    }
  } else if (!options.force && !canPrompt(options)) {
    throw new TunnelCliError('Refusing to delete without confirmation. Re-run with --force (or --yes) to proceed.', EXIT_CODE.USAGE_ERROR);
  }

  await apiRequest(port, 'DELETE', `/api/session/${encodeURIComponent(id)}`, {
    query: { directory },
    options,
    timeoutMs: 15000,
  });

  if (isJsonMode(options)) {
    printJson({ deleted: true, id });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${id} deleted\n`);
    return;
  }
  clackIntro('Delete Session');
  logStatus('success', `Deleted ${id}`);
  clackOutro('done');
}

async function sessionCommand(options = {}, action = 'list', args = []) {
  const normalizedAction = typeof action === 'string' && action.trim().length > 0 ? action.trim() : 'list';
  if (!SESSION_ACTIONS.includes(normalizedAction)) {
    throw new TunnelCliError(
      `Unknown session action '${normalizedAction}'. Valid actions: ${SESSION_ACTIONS.join(', ')}.`,
      EXIT_CODE.USAGE_ERROR,
    );
  }

  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);

  switch (normalizedAction) {
    case 'list':
      return handleList(port, directory, options);
    case 'show':
      return handleShow(port, directory, options, args);
    case 'rename':
      return handleRename(port, directory, options, args);
    case 'archive':
      return handleArchiveToggle(port, directory, options, args, true);
    case 'unarchive':
      return handleArchiveToggle(port, directory, options, args, false);
    case 'share':
      return handleShare(port, directory, options, args, true);
    case 'unshare':
      return handleShare(port, directory, options, args, false);
    case 'delete':
      return handleDelete(port, directory, options, args);
    default:
      return undefined;
  }
}

export { sessionCommand };
