/**
 * CLI output formatting adapter.
 *
 * Wraps @clack/prompts for structured, beautiful terminal output.
 * Custom formatters (icons, redaction) live here to isolate the
 * formatting dependency from the rest of the CLI.
 */

import {
  intro,
  outro,
  log,
  note,
  box,
  progress,
  spinner,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
} from '@clack/prompts';

// ── Provider icons ──────────────────────────────────────────────

const TUNNEL_PROVIDER_ICON = {
  cloudflare: '☁',
};

function formatProviderWithIcon(provider) {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return 'unknown';
  }
  const normalized = provider.trim().toLowerCase();
  const icon = TUNNEL_PROVIDER_ICON[normalized];
  return icon ? `${icon} ${normalized}` : normalized;
}

// ── Status-aware log dispatch ───────────────────────────────────

/**
 * Print a status-tagged message using clack log primitives.
 *
 * @param {'success'|'warning'|'error'|'info'|'neutral'} status
 * @param {string} message  Primary line
 * @param {string} [detail] Optional dim secondary line appended after newline
 */
function logStatus(status, message, detail) {
  const full = detail ? `${message}\n${detail}` : message;
  switch (status) {
    case 'success':
      log.success(full);
      break;
    case 'warning':
      log.warn(full);
      break;
    case 'error':
      log.error(full);
      break;
    case 'info':
    case 'neutral':
    default:
      log.info(full);
      break;
  }
}

// ── TTY detection ───────────────────────────────────────────────

/**
 * Whether both stdout and stdin are interactive TTYs.
 * Prompts must be disabled when stdin is piped (e.g. --token-stdin).
 */
const isTTY = Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY);

function isJsonMode(options) {
  return Boolean(options?.json);
}

function isQuietMode(options) {
  return Boolean(options?.quiet);
}

function shouldRenderHumanOutput(options) {
  return !isJsonMode(options) && !isQuietMode(options);
}

function canPrompt(options) {
  return shouldRenderHumanOutput(options) && isTTY;
}

function createSpinner(options) {
  return canPrompt(options) ? spinner() : null;
}

async function createProgress(options, config) {
  return canPrompt(options) ? progress(config) : null;
}

function printJson(payload) {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : { data: payload };

  const messages = Array.isArray(base.messages) ? base.messages : undefined;
  const hasWarning = Boolean(messages?.some((entry) => entry?.level === 'warning'));
  const hasError = Boolean(messages?.some((entry) => entry?.level === 'error'));
  const normalizedStatus = base.status === 'ok' || base.status === 'warning' || base.status === 'error'
    ? base.status
    : (hasError ? 'error' : (hasWarning ? 'warning' : 'ok'));

  const output = {
    status: normalizedStatus,
    ...base,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export {
  intro,
  outro,
  log,
  note,
  box,
  progress,
  spinner,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
  isTTY,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  formatProviderWithIcon,
  logStatus,
};
