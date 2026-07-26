import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const WAIT_HTTP_TIMEOUT_BUFFER_MS = 30_000;

// The control service blocks server-side while wait is set, so the client
// HTTP timeout must outlive the requested wait window instead of the short
// default used for instant control calls.
export const resolveControlTimeoutMs = (input, options) => {
  if (Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0) return options.timeoutMs;
  if (input?.wait !== true) return undefined;
  const waitSeconds = Number(input?.timeout) > 0 ? Number(input.timeout) : DEFAULT_WAIT_TIMEOUT_SECONDS;
  return (waitSeconds * 1000) + WAIT_HTTP_TIMEOUT_BUFFER_MS;
};

export const requestControlAction = async (port, action, input, options = {}) => {
  const timeoutMs = resolveControlTimeoutMs(input, options);
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
  const partial = partialSessionId
    ? ` ${partialSubject} ${partialSessionId} remains available${partialDirectory ? ` in ${partialDirectory}` : ''}.`
    : '';
  const message = `${asNonEmptyString(body?.error) || `Failed to execute ${action}`}${partial}`;
  const status = Number(response?.status);
  throw new TunnelCliError(message, status === 400 || status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
};
