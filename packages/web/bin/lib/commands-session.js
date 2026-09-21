import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import { requestControlAction } from './cli-control.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

const normalizeMessageRole = (value) => {
  const role = asNonEmptyString(value) || 'all';
  if (!['all', 'user', 'assistant'].includes(role)) {
    throw new TunnelCliError('--role must be one of: all, user, assistant.', EXIT_CODE.USAGE_ERROR);
  }
  return role;
};

const formatTextMessage = (message) => {
  const label = message.role === 'user' ? 'User' : 'Assistant';
  const timestamp = message.createdAt ? new Date(message.createdAt).toISOString() : '';
  const details = [timestamp, message.model].filter(Boolean).join(' ');
  return `**${label}**${details ? `\n\n*${details}*` : ''}\n\n${message.text}`;
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

const buildSessionPromptPayload = (options = {}, action) => {
  const { directory } = assertSessionTarget(options);
  const prompt = asNonEmptyString(options.prompt);
  if (!prompt) throw new TunnelCliError('Missing required --prompt.', EXIT_CODE.USAGE_ERROR);
  const model = validateModel(options.model);
  const agent = asNonEmptyString(options.agent);
  const variant = asNonEmptyString(options.variant);
  const messageId = asNonEmptyString(options.message);
  if (messageId && action !== 'fork') {
    throw new TunnelCliError('--message is only valid for session fork.', EXIT_CODE.USAGE_ERROR);
  }
  const goalEnabled = options.goal === true;
  const goalTokenBudget = parseGoalTokenBudget(options);
  return {
    directory,
    prompt,
    ...(messageId ? { messageId } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
    ...(goalEnabled ? { goal: true } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
  };
};

const validateActionWaitOptions = (options, action) => {
  if (options.timeout !== undefined && !options.wait) {
    throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
  }
  if (options.lastAssistant && !options.wait) {
    throw new TunnelCliError(`--last-assistant requires --wait for session ${action}.`, EXIT_CODE.USAGE_ERROR);
  }
};

async function sessionCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Session Commands\n\nUSAGE:\n  openchamber session list [--dir <path>] [--limit <count>] [--with-status] [OPTIONS]\n  openchamber session create --dir <path> [--title <title>] [--wait] [OPTIONS]\n  openchamber session create --project <projectId> [--title <title>] [--wait] [OPTIONS]\n  openchamber session send --session <id> --dir <path> --prompt <text> [--wait] [OPTIONS]\n  openchamber session fork --session <id> --dir <path> --prompt <text> [--message <id>] [--wait] [OPTIONS]\n  openchamber session status --session <id> --dir <path> [OPTIONS]\n  openchamber session messages --session <id> --dir <path> [--wait] [OPTIONS]\n\nLIST OPTIONS:\n  --dir <path>            Filter sessions by directory\n  --limit <count>         Maximum sessions to show (default: 10)\n  --all                   Include archived sessions\n  --with-status           Include authoritative idle/busy/retry status\n\nACTION OPTIONS:\n  --session <id>          Source or target session id\n  --dir <path>            Authoritative session directory\n  --prompt <text>         Prompt to send to the session\n  --message <id>          Fork from this message (fork only; default: latest)\n  --model <provider/model>  Model for the prompt (defaults to configured selection)\n  --agent <id>            Agent for the prompt (defaults to configured selection)\n  --variant <id>          Model variant for the prompt\n  --goal                  Run the prompt as a new goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --wait                  Wait for the dispatched activity to become idle\n  --last-assistant        Include the last assistant text after waiting\n  --timeout <seconds>     Wait timeout in seconds (default: 600, max: 86400)\n\nCREATE OPTIONS:\n  --worktree <name>       Create a git worktree before creating the session\n  --branch <name>         Branch name for --worktree\n  --start-ref, --base <ref>  Start ref for --worktree\n  --upstream              Set upstream for the worktree branch\n  --no-upstream           Do not set upstream for the worktree branch\n  --name <title>          Alias for --title\n\nSTATUS/MESSAGES OPTIONS:\n  --last                  Return only the latest text-bearing message\n  --last-assistant        Shorthand for --last --role assistant\n  --limit <count>         Maximum text messages to return (default: 10)\n  --all                   Return all text-bearing messages\n  --role <role>           Filter messages: all, user, assistant\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print compact output\n`);
    return;
  }

  if (action === 'list') {
    const limit = normalizeLimit(options.limit);
    const port = await resolveTargetPort(options);
    const body = await requestControlAction(port, 'session.list', {
      ...(asNonEmptyString(options.directory) ? { directory: options.directory.trim() } : {}),
      limit,
      all: options.all === true,
      withStatus: options.withStatus === true,
    }, options);
    const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
    if (isJsonMode(options)) {
      printJson(body);
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
    const result = await requestControlAction(port, 'session.status', { sessionId, directory }, options);
    const status = result.sessionStatus;
    if (isJsonMode(options)) {
      printJson(result);
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
    const limit = options.all ? undefined : (last ? undefined : normalizeLimit(options.limit));
    const port = await resolveTargetPort(options);
    const result = await requestControlAction(port, 'session.messages', {
      sessionId,
      directory,
      role,
      all: options.all === true,
      last,
      ...(limit !== undefined ? { limit } : {}),
      wait: options.wait === true,
      ...(options.timeout !== undefined ? { timeout: Number(options.timeout) } : {}),
      lastAssistant: options.lastAssistant === true,
    }, options);
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    if (isJsonMode(options)) {
      printJson(result);
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

  if (action === 'send' || action === 'fork') {
    const { sessionId } = assertSessionTarget(options);
    const payload = buildSessionPromptPayload(options, action);
    validateActionWaitOptions(options, action);
    const port = await resolveTargetPort(options);
    const result = await requestControlAction(port, `session.${action}`, {
      ...payload,
      sessionId,
      wait: options.wait === true,
      ...(options.timeout !== undefined ? { timeout: Number(options.timeout) } : {}),
      lastAssistant: options.lastAssistant === true,
    }, options);
    const { sessionStatus, lastAssistantMessage } = result;
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${result?.sessionId || ''}\n`);
      if (lastAssistantMessage?.text) process.stdout.write(`${lastAssistantMessage.text}\n`);
      return;
    }
    clackIntro(action === 'fork' ? 'Session Forked' : 'Session Prompt Sent');
    logStatus('success', result?.sessionId || `${action} completed`, `directory: ${result?.directory || 'unknown'}`);
    if (result?.promptDispatched) {
      logStatus('info', result.dispatchedAsCommand ? 'command dispatched' : 'prompt dispatched');
    }
    if (result?.goalEnabled) {
      logStatus('info', 'goal mode active', result.goalTokenBudget ? `budget: ${result.goalTokenBudget}` : undefined);
    }
    if (sessionStatus) logStatus('info', `session status: ${sessionStatus.type}`);
    clackOutro(action === 'fork' ? 'forked' : 'sent');
    if (lastAssistantMessage) process.stdout.write(`\n${formatTextMessage(lastAssistantMessage)}\n`);
    return;
  }

  if (action !== 'create') {
    throw new TunnelCliError(`Unknown session command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const payload = buildSessionCreatePayload(options);
  validateActionWaitOptions(options, 'create');
  const port = await resolveTargetPort(options);
  const controlPayload = { ...payload };
  if (payload.worktree) {
    controlPayload.worktree = payload.worktree.name;
    controlPayload.branch = payload.worktree.branchName;
    controlPayload.startRef = payload.worktree.startRef;
  }
  const result = await requestControlAction(port, 'session.create', {
    ...controlPayload,
    wait: options.wait === true,
    ...(options.timeout !== undefined ? { timeout: Number(options.timeout) } : {}),
    lastAssistant: options.lastAssistant === true,
  }, options);
  const { sessionStatus, lastAssistantMessage } = result;

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${result?.sessionId || ''}\n`);
    if (lastAssistantMessage?.text) process.stdout.write(`${lastAssistantMessage.text}\n`);
    return;
  }

  clackIntro('Session Created');
  logStatus('success', result?.sessionId || 'session created', `directory: ${result?.directory || 'unknown'}`);
  if (result?.worktree?.path) {
    logStatus('info', `worktree: ${result.worktree.branch || result.worktree.name || 'created'}`, result.worktree.path);
  }
  if (result?.promptDispatched) {
    logStatus('info', result.dispatchedAsCommand ? 'initial command dispatched' : 'initial prompt dispatched');
  }
  if (result?.goalEnabled) {
    logStatus('info', 'goal mode active', result.goalTokenBudget ? `budget: ${result.goalTokenBudget}` : undefined);
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
  buildSessionPromptPayload,
  formatSessionLine,
};
