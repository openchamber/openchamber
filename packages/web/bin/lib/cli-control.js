import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
import { shellQuote } from './cli-shell.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const WAIT_HTTP_TIMEOUT_BUFFER_MS = 30_000;

const WORKTREE_PROVISION_TIMEOUT_MS = 6 * 60_000;

export const resolveControlTimeoutMs = (input, options, action) => {
  if (Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0) return options.timeoutMs;
  const needsCheckoutPreparation = action === 'session.create' || asNonEmptyString(input?.worktree) !== null;
  if (input?.wait !== true) {
    return needsCheckoutPreparation ? WORKTREE_PROVISION_TIMEOUT_MS : undefined;
  }
  const waitSeconds = Number(input?.timeout) > 0 ? Number(input.timeout) : DEFAULT_WAIT_TIMEOUT_SECONDS;
  const waitTimeoutMs = (waitSeconds * 1000) + WAIT_HTTP_TIMEOUT_BUFFER_MS;
  return needsCheckoutPreparation ? waitTimeoutMs + WORKTREE_PROVISION_TIMEOUT_MS : waitTimeoutMs;
};

export const requestControlAction = async (port, action, input, options = {}) => {
  const timeoutMs = resolveControlTimeoutMs(input, options, action);
  const { response, body } = await requestJson(port, '/api/openchamber/control', {
    ...options,
    ...(timeoutMs ? { timeoutMs } : {}),
    method: 'POST',
    body: JSON.stringify({ action, input }),
  });
  if (response?.ok) return body;
  const isPartial = body?.partial === true;
  const partialSessionId = isPartial ? asNonEmptyString(body?.sessionId) : null;
  const partialDirectory = isPartial ? asNonEmptyString(body?.directory) : null;
  const partialSubject = body?.partialAction === 'goal-configured' ? 'Goal on session' : 'Forked session';
  let partial = partialSessionId
    ? ` ${partialSubject} ${partialSessionId} remains available${partialDirectory ? ` in ${partialDirectory}` : ''}.`
    : '';
  if (isPartial && body?.partialAction === 'worktree-created' && partialDirectory) {
    const retry = ['openchamber session create', '--directory', shellQuote(partialDirectory), '--port', String(port)];
    for (const key of ['prompt', 'title', 'model', 'agent', 'variant', 'timeout']) {
      if (input?.[key] != null) retry.push(`--${key}`, shellQuote(input[key]));
    }
    for (const [key, flag] of [['goal', '--goal'], ['wait', '--wait'], ['lastAssistant', '--last-assistant']]) {
      if (input?.[key] === true) retry.push(flag);
    }
    if (input?.goalTokenBudget != null) retry.push('--goal-token-budget', String(input.goalTokenBudget));
    partial = ` A worktree remains at ${partialDirectory}. Retry without --worktree: ${retry.join(' ')}`;
  }
  const message = `${asNonEmptyString(body?.error) || `Failed to execute ${action}`}${partial}`;
  const status = Number(response?.status);
  throw new TunnelCliError(message, status === 400 || status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
};
