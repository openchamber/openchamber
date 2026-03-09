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
 * Whether stdout is an interactive TTY.
 * All interactive prompts (confirm, select, password) must guard on this.
 */
const isTTY = Boolean(process.stdout?.isTTY);

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
  formatProviderWithIcon,
  logStatus,
};
