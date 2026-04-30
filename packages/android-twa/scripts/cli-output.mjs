/**
 * CLI output formatting adapter for android-twa build scripts.
 *
 * Wraps @clack/prompts for structured, beautiful terminal output.
 * Provides mode detection, output formatting, and CLI lifecycle helpers
 * so individual scripts stay focused on behavior and policy.
 *
 * Follows the pattern from packages/web/bin/cli-output.js.
 *
 * Core principle: policy-first, UX-second.
 * Clack is presentation, not enforcement.
 */

import {
  intro,
  outro,
  log,
  spinner,
  confirm,
  text,
  password,
  cancel,
  isCancel,
} from '@clack/prompts'

// ── TTY detection ───────────────────────────────────────────────

/**
 * Whether stdout is an interactive TTY.
 * Prompts must be disabled when stdout is piped.
 */
const isTTY = Boolean(process.stdout?.isTTY)

// ── Mode detection ──────────────────────────────────────────────

/**
 * Check if --quiet flag is present in process.argv.
 * --quiet suppresses non-essential output but does not weaken validation.
 */
function isQuietMode() {
  return process.argv.includes('--quiet')
}

/**
 * Check if --json flag is present in process.argv.
 * --json changes output shape only; it does not weaken validation.
 */
function isJsonMode() {
  return process.argv.includes('--json')
}

/**
 * Whether to render human-facing output (Clack UX).
 * Returns false in --json and --quiet modes.
 */
function shouldRenderHumanOutput() {
  return !isJsonMode() && !isQuietMode()
}

/**
 * Whether prompts can be shown.
 * Only when: stdout is TTY AND not --quiet AND not --json.
 */
function canPrompt() {
  return shouldRenderHumanOutput() && isTTY
}
// ── Output helpers ─────────────────────────────────────────────

/**
 * Print a JSON payload to stdout.
 * Used for --json mode output. Always includes an `ok` field.
 *
 * @param {Record<string, unknown>} payload
 */
function printJson(payload) {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ok: true, ...payload }
    : { ok: true, data: payload }

  process.stdout.write(`${JSON.stringify(base, null, 2)}\n`)
}

/**
 * Create a clack spinner if interactive, null otherwise.
 * Callers should guard: `spin?.start('msg')` / `spin?.stop('msg')`.
 */
function createSpinner() {
  return canPrompt() ? spinner() : null
}

/**
 * Format an error for the current output mode.
 * - --json: returns JSON string with ok:false
 * - --quiet: returns plain error message string
 * - interactive: returns plain error message string (caller uses log.error)
 */
function formatError(error) {
  const message = error instanceof Error ? error.message : String(error)

  if (isJsonMode()) {
    return JSON.stringify({ ok: false, error: message })
  }

  return message
}

// ── CLI lifecycle helpers ──────────────────────────────────────

/**
 * Run mainFn only when the script is executed directly (not imported).
 * Wraps execution with structured error handling across all output modes.
 *
 * Replaces the pattern:
 *   if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('script.mjs')) {
 *     main()
 *   }
 *
 * @param {string} importMetaUrl - import.meta.url from the calling script
 * @param {() => Promise<void>} mainFn - async main function to run
 */
async function runIfMain(importMetaUrl, mainFn) {
  const scriptPath = process.argv[1] || ''
  const isDirectExecution =
    importMetaUrl === `file://${scriptPath}` ||
    scriptPath.endsWith(new URL(importMetaUrl).pathname.split('/').pop())

  if (!isDirectExecution) return

  try {
    await mainFn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (isJsonMode()) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    } else if (isQuietMode()) {
      console.error(message)
    } else {
      log.error(message)
    }
    process.exit(1)
  }
}

export {
  intro,
  outro,
  log,
  spinner,
  confirm,
  text,
  password,
  cancel,
  isCancel,
  isTTY,
  isQuietMode,
  isJsonMode,
  shouldRenderHumanOutput,
  canPrompt,
  printJson,
  createSpinner,
  formatError,
  runIfMain,
}
