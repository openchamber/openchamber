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
} from '../cli-output.js';

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
  return `- \`${title}\` — ${selections.join(', ')} — \`${directory}\``;
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
    process.stdout.write(`OpenChamber Session Commands\n\nUSAGE:\n  openchamber session list [--dir <path>] [--limit <count>] [OPTIONS]\n  openchamber session create --dir <path> [--title <title>] [OPTIONS]\n  openchamber session create --project <projectId> [--title <title>] [OPTIONS]\n\nLIST OPTIONS:\n  --dir <path>            Filter sessions by directory\n  --limit <count>         Maximum sessions to show (default: 10)\n  --all                   Include archived sessions\n\nCREATE OPTIONS:\n  --worktree <name>       Create a git worktree before creating the session\n  --branch <name>         Branch name for --worktree\n  --start-ref, --base <ref>  Start ref for --worktree\n  --upstream              Set upstream for the worktree branch\n  --no-upstream           Do not set upstream for the worktree branch\n  --prompt <text>         Send an initial prompt after session creation\n  --model <provider/model>  Model for the initial prompt (defaults to configured selection)\n  --agent <id>            Agent for the initial prompt (defaults to configured selection)\n  --variant <id>          Model variant for the initial prompt\n  --goal                  Continue the session toward the initial prompt as a goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --name <title>          Alias for --title\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print compact output\n`);
    return;
  }

  if (action === 'list') {
    const limit = normalizeLimit(options.limit);
    const port = await resolveTargetPort(options);
    const { response, body } = await requestJson(port, buildSessionListEndpoint(options), options);
    assertOk(response, body, 'Failed to load sessions');
    const sessions = filterVisibleSessions(body, options).slice(0, limit);
    if (isJsonMode(options)) {
      printJson({ sessions, limit, directory: asNonEmptyString(options.directory), archived: options.all ? 'included' : 'excluded' });
      return;
    }
    process.stdout.write(sessions.length > 0
      ? `${sessions.map(formatSessionLine).join('\n')}\n`
      : 'No sessions found.\n');
    return;
  }

  if (action !== 'create') {
    throw new TunnelCliError(`Unknown session command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const payload = buildSessionCreatePayload(options);
  const port = await resolveTargetPort(options);
  const { response, body } = await requestJson(port, '/api/openchamber/sessions', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assertOk(response, body, 'Failed to create session');

  if (isJsonMode(options)) {
    printJson(body || {});
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${body?.sessionId || ''}\n`);
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
  clackOutro('created');
}

export { sessionCommand, buildSessionCreatePayload, formatSessionLine, buildSessionListEndpoint, filterVisibleSessions };
