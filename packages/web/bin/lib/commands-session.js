import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
  createSpinner,
} from '../cli-output.js';

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertOk = (response, body, fallback) => {
  if (response?.ok) return;
  const message = asNonEmptyString(body?.error) || fallback;
  const exitCode = response?.status === 400 || response?.status === 404
    ? EXIT_CODE.USAGE_ERROR
    : EXIT_CODE.GENERAL_ERROR;
  throw new TunnelCliError(message, exitCode);
};

const validateModel = (model) => {
  const normalized = asNonEmptyString(model);
  if (!normalized) return null;
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    throw new TunnelCliError('--model must be in provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const normalizeLimit = (value, fallback = 10) => {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TunnelCliError('Invalid limit value. Provide a positive integer.', EXIT_CODE.USAGE_ERROR);
  }
  return parsed;
};

const assertSessionTarget = (options = {}) => {
  const sessionId = asNonEmptyString(options.session);
  const directory = asNonEmptyString(options.directory);
  if (!sessionId) {
    throw new TunnelCliError('Missing required --session.', EXIT_CODE.USAGE_ERROR);
  }
  if (!directory) {
    throw new TunnelCliError('Missing required --dir.', EXIT_CODE.USAGE_ERROR);
  }
  return { sessionId, directory };
};

const buildSessionStatusEndpoint = (directory) => {
  const params = new URLSearchParams({ directory });
  return `/api/session/status?${params.toString()}`;
};

const buildSessionMessagesEndpoint = (sessionId, directory, limit) => {
  const params = new URLSearchParams({ directory });
  if (limit !== undefined) params.set('limit', String(limit));
  return `/api/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`;
};

const resolveSessionStatus = (statuses, sessionId) => {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null;
  const status = statuses[sessionId];
  if (status && typeof status === 'object' && typeof status.type === 'string') return status;
  return { type: 'idle' };
};

const normalizeMessageRole = (value) => {
  const role = asNonEmptyString(value) || 'all';
  if (!['all', 'user', 'assistant'].includes(role)) {
    throw new TunnelCliError('--role must be one of: all, user, assistant.', EXIT_CODE.USAGE_ERROR);
  }
  return role;
};

const normalizeWaitTimeoutMs = (value) => {
  if (value === undefined || value === null) return DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new TunnelCliError('--timeout must be an integer number of seconds.', EXIT_CODE.USAGE_ERROR);
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new TunnelCliError(`--timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds.`, EXIT_CODE.USAGE_ERROR);
  }
  return seconds * 1000;
};

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const waitForSessionIdle = async ({
  fetchStatus,
  timeoutMs,
  requireActivity = false,
  hasCompletedResult = async () => false,
  pollIntervalMs = WAIT_POLL_INTERVAL_MS,
  now = Date.now,
  wait = sleep,
}) => {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let observedActivity = false;

  while (true) {
    const status = await fetchStatus();
    if (status.type === 'busy' || status.type === 'retry') {
      observedActivity = true;
    } else if (!requireActivity || observedActivity || await hasCompletedResult()) {
      return status;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new TunnelCliError(
        `Session did not become idle within ${Math.ceil(timeoutMs / 1000)} seconds.`,
        EXIT_CODE.GENERAL_ERROR,
      );
    }
    await wait(Math.min(pollIntervalMs, remainingMs));
  }
};

const extractTextMessages = (messages, role = 'all') => {
  const source = Array.isArray(messages) ? messages : [];
  const textMessages = [];

  for (const record of source) {
    const info = record?.info;
    const messageRole = info?.role;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) {
      continue;
    }

    const text = Array.isArray(record?.parts)
      ? record.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim()
      : '';
    if (!text) continue;

    const providerID = asNonEmptyString(info.providerID);
    const modelID = asNonEmptyString(info.modelID);
    textMessages.push({
      id: asNonEmptyString(info.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(info?.time?.created) ? info.time.created : null,
      completedAt: Number.isFinite(info?.time?.completed) ? info.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    });
  }

  return textMessages.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

const formatTextMessage = (message) => {
  const label = message.role === 'user' ? 'User' : 'Assistant';
  const timestamp = message.createdAt ? new Date(message.createdAt).toISOString() : '';
  const details = [timestamp, message.model].filter(Boolean).join(' ');
  return `**${label}**${details ? `\n\n*${details}*` : ''}\n\n${message.text}`;
};

const fetchSessionStatus = async (port, sessionId, directory, options) => {
  const { response, body } = await requestJson(port, buildSessionStatusEndpoint(directory), options);
  assertOk(response, body, 'Failed to load session status');
  const status = resolveSessionStatus(body, sessionId);
  if (!status) throw new TunnelCliError('Invalid session status response.', EXIT_CODE.GENERAL_ERROR);
  return status;
};

const fetchSessionTextMessages = async ({ port, sessionId, directory, role, limit, options }) => {
  const fetchMessages = async (upstreamLimit) => {
    const { response, body } = await requestJson(
      port,
      buildSessionMessagesEndpoint(sessionId, directory, upstreamLimit),
      { ...options, timeoutMs: 15_000 },
    );
    assertOk(response, body, 'Failed to load session messages');
    if (!Array.isArray(body)) throw new TunnelCliError('Invalid session messages response.', EXIT_CODE.GENERAL_ERROR);
    return body;
  };
  const fetchLimit = limit === undefined ? undefined : Math.max(100, limit * 4);
  let rawMessages = await fetchMessages(fetchLimit);
  let textMessages = extractTextMessages(rawMessages, role);
  if (limit !== undefined && textMessages.length < limit && rawMessages.length >= fetchLimit) {
    rawMessages = await fetchMessages(undefined);
    textMessages = extractTextMessages(rawMessages, role);
  }
  return limit === undefined ? textMessages : textMessages.slice(-limit);
};

const formatSessionModel = (session) => {
  const model = session?.model;
  const providerID = asNonEmptyString(model?.providerID) || asNonEmptyString(model?.providerId);
  const modelID = asNonEmptyString(model?.id) || asNonEmptyString(model?.modelID) || asNonEmptyString(model?.modelId);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const formatSessionLine = (session) => {
  const title = asNonEmptyString(session?.title) || asNonEmptyString(session?.slug) || asNonEmptyString(session?.id) || 'untitled';
  const model = formatSessionModel(session) || 'unknown-model';
  const agent = asNonEmptyString(session?.agent) || 'unknown-agent';
  const variant = asNonEmptyString(session?.model?.variant);
  const directory = asNonEmptyString(session?.directory) || 'unknown-directory';
  const selections = [`\`${model}\``, `\`${agent}\``];
  if (variant && variant !== 'default') selections.push(`\`${variant}\``);
  const status = asNonEmptyString(session?.status?.type);
  return `- \`${title}\` — ${selections.join(', ')}${status ? ` — status:${status}` : ''} — \`${directory}\``;
};

const buildSessionListEndpoint = (options = {}) => {
  const params = new URLSearchParams();
  const directory = asNonEmptyString(options.directory);
  if (directory) params.set('directory', directory);
  return `/api/session${params.toString() ? `?${params.toString()}` : ''}`;
};

const filterVisibleSessions = (sessions, options = {}) => {
  const list = Array.isArray(sessions) ? sessions : [];
  return options.all ? list : list.filter((session) => !session?.time?.archived);
};

const buildSessionCreatePayload = (options = {}) => {
  const directory = asNonEmptyString(options.directory);
  const projectId = asNonEmptyString(options.project);
  if (!directory && !projectId) {
    throw new TunnelCliError('Missing required --dir or --project.', EXIT_CODE.USAGE_ERROR);
  }
  if (directory && projectId) {
    throw new TunnelCliError('Provide only one of --dir or --project.', EXIT_CODE.USAGE_ERROR);
  }

  const prompt = asNonEmptyString(options.prompt);
  const model = validateModel(options.model);
  const goalEnabled = options.goal === true;
  const goalTokenBudget = parseGoalTokenBudget(options);
  if (goalEnabled && !prompt) {
    throw new TunnelCliError('--goal requires --prompt.', EXIT_CODE.USAGE_ERROR);
  }

  const title = asNonEmptyString(options.title) || asNonEmptyString(options.name);
  const agent = asNonEmptyString(options.agent);
  const variant = asNonEmptyString(options.variant);
  const worktree = asNonEmptyString(options.worktree);
  const branch = asNonEmptyString(options.branch);
  const startRef = asNonEmptyString(options.startRef);

  return {
    ...(directory ? { directory } : {}),
    ...(projectId ? { projectId } : {}),
    ...(title ? { title } : {}),
    ...(worktree ? { worktree: { name: worktree, ...(branch ? { branchName: branch } : {}), ...(startRef ? { startRef } : {}) } } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
    ...(goalEnabled ? { goal: true } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    ...(typeof options.setUpstream === 'boolean' ? { setUpstream: options.setUpstream } : {}),
  };
};

async function sessionCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Session Commands\n\nUSAGE:\n  openchamber session list [--dir <path>] [--limit <count>] [--with-status] [OPTIONS]\n  openchamber session create --dir <path> [--title <title>] [--wait] [OPTIONS]\n  openchamber session create --project <projectId> [--title <title>] [--wait] [OPTIONS]\n  openchamber session status --session <id> --dir <path> [OPTIONS]\n  openchamber session messages --session <id> --dir <path> [--wait] [OPTIONS]\n\nLIST OPTIONS:\n  --dir <path>            Filter sessions by directory\n  --limit <count>         Maximum sessions to show (default: 10)\n  --all                   Include archived sessions\n  --with-status           Include authoritative idle/busy/retry status\n\nCREATE OPTIONS:\n  --worktree <name>       Create a git worktree before creating the session\n  --branch <name>         Branch name for --worktree\n  --start-ref, --base <ref>  Start ref for --worktree\n  --upstream              Set upstream for the worktree branch\n  --no-upstream           Do not set upstream for the worktree branch\n  --prompt <text>         Send an initial prompt after session creation\n  --model <provider/model>  Model for the initial prompt (defaults to configured selection)\n  --agent <id>            Agent for the initial prompt (defaults to configured selection)\n  --variant <id>          Model variant for the initial prompt\n  --goal                  Continue the session toward the initial prompt as a goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --wait                  Wait for the current session activity to become idle\n  --last-assistant        Include the last assistant text after waiting\n  --timeout <seconds>     Wait timeout in seconds (default: 600, max: 86400)\n  --name <title>          Alias for --title\n\nSTATUS/MESSAGES OPTIONS:\n  --session <id>          Session id\n  --dir <path>            Session directory (required for authoritative scope)\n  --wait                  Wait for current activity to become idle before reading\n  --timeout <seconds>     Wait timeout in seconds (default: 600, max: 86400)\n  --last                  Return only the latest text-bearing message\n  --last-assistant        Shorthand for --last --role assistant\n  --limit <count>         Maximum text messages to return (default: 10)\n  --all                   Return all text-bearing messages\n  --role <role>           Filter messages: all, user, assistant\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print compact output\n`);
    return;
  }

  if (action === 'list') {
    const limit = normalizeLimit(options.limit);
    const port = await resolveTargetPort(options);
    const { response, body } = await requestJson(port, buildSessionListEndpoint(options), options);
    assertOk(response, body, 'Failed to load sessions');
    let sessions = filterVisibleSessions(body, options).slice(0, limit);
    if (options.withStatus) {
      const statusMaps = new Map();
      const directories = [...new Set(sessions.map((session) => asNonEmptyString(session?.directory)).filter(Boolean))];
      await Promise.all(directories.map(async (directory) => {
        try {
          const { response: statusResponse, body: statusBody } = await requestJson(
            port,
            buildSessionStatusEndpoint(directory),
            options,
          );
          statusMaps.set(directory, statusResponse?.ok ? statusBody : null);
        } catch {
          statusMaps.set(directory, null);
        }
      }));
      sessions = sessions.map((session) => {
        const directory = asNonEmptyString(session?.directory);
        const status = directory ? resolveSessionStatus(statusMaps.get(directory), session.id) : null;
        return { ...session, status: status || { type: 'unknown' } };
      });
    }
    if (isJsonMode(options)) {
      printJson({ sessions, limit, directory: asNonEmptyString(options.directory), archived: options.all ? 'included' : 'excluded' });
      return;
    }
    process.stdout.write(sessions.length > 0
      ? `${sessions.map(formatSessionLine).join('\n')}\n`
      : 'No sessions found.\n');
    return;
  }

  if (action === 'status') {
    const { sessionId, directory } = assertSessionTarget(options);
    const port = await resolveTargetPort(options);
    const status = await fetchSessionStatus(port, sessionId, directory, options);
    if (isJsonMode(options)) {
      printJson({ status: 'ok', sessionId, directory, sessionStatus: status });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${status.type}\n`);
      return;
    }
    process.stdout.write(`${sessionId} status:${status.type} directory:${directory}\n`);
    return;
  }

  if (action === 'messages') {
    const { sessionId, directory } = assertSessionTarget(options);
    if (options.timeout !== undefined && !options.wait) {
      throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
    }
    if (options.lastAssistant && options.role && options.role !== 'assistant') {
      throw new TunnelCliError('--last-assistant cannot be combined with a non-assistant --role.', EXIT_CODE.USAGE_ERROR);
    }
    const role = options.lastAssistant ? 'assistant' : normalizeMessageRole(options.role);
    const last = options.last || options.lastAssistant;
    if (options.all && (last || options.limit !== undefined)) {
      throw new TunnelCliError('--all cannot be combined with --last or --limit.', EXIT_CODE.USAGE_ERROR);
    }
    if (last && options.limit !== undefined) {
      throw new TunnelCliError('--last cannot be combined with --limit.', EXIT_CODE.USAGE_ERROR);
    }
    const limit = options.all ? undefined : (last ? 1 : normalizeLimit(options.limit));
    const port = await resolveTargetPort(options);
    if (options.wait) {
      const timeoutMs = normalizeWaitTimeoutMs(options.timeout);
      const spin = createSpinner(options);
      spin?.start('Waiting for session to become idle');
      try {
        await waitForSessionIdle({
          timeoutMs,
          fetchStatus: () => fetchSessionStatus(port, sessionId, directory, options),
        });
        spin?.stop('Session is idle');
      } catch (error) {
        spin?.stop('Wait failed');
        throw error;
      }
    }
    const messages = await fetchSessionTextMessages({ port, sessionId, directory, role, limit, options });
    if (isJsonMode(options)) {
      printJson({ status: 'ok', sessionId, directory, role, messages });
      return;
    }
    if (messages.length === 0) {
      process.stdout.write('No text messages found.\n');
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${messages.map((message) => message.text).join('\n\n')}\n`);
      return;
    }
    process.stdout.write(`${messages.map(formatTextMessage).join('\n\n---\n\n')}\n`);
    return;
  }

  if (action !== 'create') {
    throw new TunnelCliError(`Unknown session command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const payload = buildSessionCreatePayload(options);
  if (options.timeout !== undefined && !options.wait) {
    throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
  }
  if (options.lastAssistant && !options.wait) {
    throw new TunnelCliError('--last-assistant requires --wait for session create.', EXIT_CODE.USAGE_ERROR);
  }
  const timeoutMs = options.wait ? normalizeWaitTimeoutMs(options.timeout) : null;
  const waitStartedAt = Date.now();
  const port = await resolveTargetPort(options);
  const { response, body } = await requestJson(port, '/api/openchamber/sessions', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assertOk(response, body, 'Failed to create session');

  let sessionStatus = null;
  let lastAssistantMessage = null;
  if (options.wait) {
    const sessionId = asNonEmptyString(body?.sessionId);
    const directory = asNonEmptyString(body?.directory);
    if (!sessionId || !directory) {
      throw new TunnelCliError('Session create response is missing sessionId or directory.', EXIT_CODE.GENERAL_ERROR);
    }
    const spin = createSpinner(options);
    spin?.start('Waiting for session to become idle');
    try {
      sessionStatus = await waitForSessionIdle({
        timeoutMs,
        requireActivity: body?.promptDispatched === true,
        fetchStatus: () => fetchSessionStatus(port, sessionId, directory, options),
        hasCompletedResult: async () => {
          const messages = await fetchSessionTextMessages({
            port,
            sessionId,
            directory,
            role: 'assistant',
            limit: 1,
            options,
          });
          return Boolean(messages[0]?.completedAt && messages[0].completedAt >= waitStartedAt);
        },
      });
      spin?.stop('Session is idle');
    } catch (error) {
      spin?.stop('Wait failed');
      throw error;
    }
    if (options.lastAssistant) {
      const messages = await fetchSessionTextMessages({
        port,
        sessionId,
        directory,
        role: 'assistant',
        limit: 1,
        options,
      });
      lastAssistantMessage = messages[0] || null;
    }
  }

  const result = {
    ...(body || {}),
    ...(sessionStatus ? { sessionStatus } : {}),
    ...(options.lastAssistant ? { lastAssistantMessage } : {}),
  };

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${body?.sessionId || ''}\n`);
    if (lastAssistantMessage?.text) process.stdout.write(`${lastAssistantMessage.text}\n`);
    return;
  }

  clackIntro('Session Created');
  logStatus('success', body?.sessionId || 'session created', `directory: ${body?.directory || 'unknown'}`);
  if (body?.worktree?.path) {
    logStatus('info', `worktree: ${body.worktree.branch || body.worktree.name || 'created'}`, body.worktree.path);
  }
  if (body?.promptDispatched) {
    logStatus('info', body.dispatchedAsCommand ? 'initial command dispatched' : 'initial prompt dispatched');
  }
  if (body?.goalEnabled) {
    logStatus('info', 'goal mode active', body.goalTokenBudget ? `budget: ${body.goalTokenBudget}` : undefined);
  }
  if (sessionStatus) {
    logStatus('info', `session status: ${sessionStatus.type}`);
  }
  clackOutro('created');
  if (lastAssistantMessage) {
    process.stdout.write(`\n${formatTextMessage(lastAssistantMessage)}\n`);
  }
}

export {
  sessionCommand,
  buildSessionCreatePayload,
  formatSessionLine,
  buildSessionListEndpoint,
  buildSessionStatusEndpoint,
  buildSessionMessagesEndpoint,
  filterVisibleSessions,
  resolveSessionStatus,
  extractTextMessages,
  normalizeWaitTimeoutMs,
  waitForSessionIdle,
};
