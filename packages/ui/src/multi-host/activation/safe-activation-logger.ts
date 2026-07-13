/**
 * Safe activation logger.
 *
 * Strips sensitive fields before logging. Never outputs tokens, keys,
 * transport URLs, descriptors, or connection details.
 */

import type { ActivationStage, SafeActivationLogger } from './types';
import { redactMeta } from './activation-errors';

// ---------------------------------------------------------------------------
// Sensitive key redaction applied to all meta objects
// ---------------------------------------------------------------------------

/**
 * Create a safe logger that redacts sensitive metadata.
 *
 * @param delegate - Optional underlying logger (console by default).
 */
export const createSafeActivationLogger = (
  delegate?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>,
): SafeActivationLogger => {
  const log = delegate ?? console;

  const format = (stage: ActivationStage, message: string, meta?: Record<string, unknown>) => {
    const prefix = `[activation:${stage}]`;
    if (meta && Object.keys(meta).length > 0) {
      return `${prefix} ${message}`;
    }
    return `${prefix} ${message}`;
  };

  return {
    debug(stage, message, meta) {
      log.debug(format(stage, message, meta), meta ? redactMeta(meta) : undefined);
    },
    info(stage, message, meta) {
      log.info(format(stage, message, meta), meta ? redactMeta(meta) : undefined);
    },
    warn(stage, message, meta) {
      log.warn(format(stage, message, meta), meta ? redactMeta(meta) : undefined);
    },
    error(stage, message, meta) {
      log.error(format(stage, message, meta), meta ? redactMeta(meta) : undefined);
    },
  };
};

/**
 * No-op logger for tests.
 */
export const noopLogger: SafeActivationLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
