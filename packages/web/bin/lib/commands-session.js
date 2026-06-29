import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
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
  if (prompt && !model) {
    throw new TunnelCliError('--model is required when --prompt is provided.', EXIT_CODE.USAGE_ERROR);
  }

  const title = asNonEmptyString(options.title) || asNonEmptyString(options.name);
  const agent = asNonEmptyString(options.agent);
  const variant = asNonEmptyString(options.variant);

  return {
    ...(directory ? { directory } : {}),
    ...(projectId ? { projectId } : {}),
    ...(title ? { title } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
  };
};

async function sessionCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Session Commands\n\nUSAGE:\n  openchamber session create --dir <path> [--title <title>] [OPTIONS]\n  openchamber session create --project <projectId> [--title <title>] [OPTIONS]\n\nCREATE OPTIONS:\n  --prompt <text>         Send an initial prompt after session creation\n  --model <provider/model>  Model for the initial prompt\n  --agent <id>            Agent for the initial prompt\n  --variant <id>          Model variant for the initial prompt\n  --name <title>          Alias for --title\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print only the session id\n`);
    return;
  }

  if (action !== 'create') {
    throw new TunnelCliError(`Unknown session command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const payload = buildSessionCreatePayload(options);
  const { response, body } = await requestJson(options.port, '/api/openchamber/sessions', {
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
  if (body?.promptDispatched) {
    logStatus('info', body.dispatchedAsCommand ? 'initial command dispatched' : 'initial prompt dispatched');
  }
  clackOutro('created');
}

export { sessionCommand, buildSessionCreatePayload };
