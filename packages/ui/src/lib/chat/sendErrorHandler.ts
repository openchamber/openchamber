/**
 * Centralized error handling for message-send failures.
 *
 * Background (https://github.com/btriapitsyn/openchamber/issues/2072):
 *   When a network/proxy timeout hit ChatInput.handleSubmit, the soft-error
 *   catch silently dropped the error if the user had no attachments. The
 *   optimistic message was rolled back, the input was cleared, and no toast
 *   surfaced. The actual message may STILL be processing on the OpenCode
 *   server, leaving the session stuck on "busy" with the user unaware of why
 *   STOP/REVERT/typing appeared broken.
 *
 *   This module:
 *     1. Classifies send errors into "attachments too large", "soft network"
 *        (timeout/failed-fetch/may-still-processing/etc.), and other hard
 *        errors.
 *     2. ALWAYS surfaces a toast for every soft network error, regardless of
 *        attachment state.
 *     3. Persists a sessionStorage recovery slot so the user can re-send the
 *        same text after the server actually finishes (or aborts).
 *
 * The util is pure (no React / no DOM access) so it can be unit-tested
 * directly. Callers inject the toast function and the recovery-slot writer
 * to keep this module environment-agnostic.
 */
import type { AttachedFile } from '@/stores/types/sessionTypes';

/** Patterns that indicate the server timed out or the connection dropped. */
export const SOFT_NETWORK_PATTERNS: readonly string[] = [
  'timeout',
  'timed out',
  'may still be processing',
  'being processed',
  'failed to fetch',
  'networkerror',
  'network error',
  'gateway timeout',
];

export const SOFT_NETWORK_EXACT: ReadonlySet<string> = new Set([
  'failed to send message',
]);

/** sessionStorage key for the recovery slot. */
export const SEND_ERROR_STORAGE_KEY = 'openchamber_last_failed_send';

export interface SendRecoverySlot {
  text: string;
  attachments: AttachedFile[];
}

export type SendErrorSource = 'send' | 'queuedAutoSend';

export interface SendErrorClassification {
  attachmentsTooLarge: boolean;
  isSoftNetwork: boolean;
}

export function classifySendError(rawMessage: string): SendErrorClassification {
  const normalized = rawMessage.toLowerCase();
  const attachmentsTooLarge =
    normalized.includes('payload too large') ||
    normalized.includes('413') ||
    normalized.includes('entity too large');
  const isSoftNetwork =
    SOFT_NETWORK_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    SOFT_NETWORK_EXACT.has(normalized);
  return { attachmentsTooLarge, isSoftNetwork };
}

export interface HandleSendErrorInput {
  rawMessage: string;
  /** Full text the user attempted to send — used for the recovery slot. */
  text: string;
  attachments: AttachedFile[];
  /** Where the error originated. Controls which i18n key is used. */
  source: SendErrorSource;
  toast: {
    error: (message: string, options?: { description?: string }) => void;
  };
  /** Returns the translated string for a key. */
  t: (key: string) => string;
  /** Writes the recovery slot to durable storage. May be a no-op on server. */
  saveRecovery?: (text: string, attachments: AttachedFile[]) => void;
  /**
   * Called when the caller should re-attach the original attachments back to
   * the composer. Mirrors the legacy `setAttachedFiles(attachments)` pattern
   * that ran in the bug-fixed branches.
   */
  onRestoreAttachments?: () => void;
}

export interface HandleSendErrorResult {
  showedToast: boolean;
  message: string;
  description?: string;
  recoveryPersisted: boolean;
}

/**
 * Process a message-send error. ALWAYS surfaces a toast — the original bug
 * was a silent `return` for soft errors with no attachments.
 */
export function handleSendError(input: HandleSendErrorInput): HandleSendErrorResult {
  const { rawMessage, text, attachments, source, toast, t, saveRecovery, onRestoreAttachments } = input;
  const { attachmentsTooLarge, isSoftNetwork } = classifySendError(rawMessage);

  // 1. Payload too large — preserve the existing per-attachment copy.
  if (attachmentsTooLarge) {
    const message = t('chat.chatInput.toast.attachmentsTooLarge');
    toast.error(message);
    if (attachments.length > 0) onRestoreAttachments?.();
    return { showedToast: true, message, recoveryPersisted: false };
  }

  // 2. Soft network error — the bug fix path. Always toast, always persist
  //    recovery if there's anything to recover. The copy explicitly tells
  //    the user the message MAY still be processing server-side so they
  //    understand why STOP/typing might not respond.
  if (isSoftNetwork) {
    const message =
      source === 'queuedAutoSend'
        ? t('chat.sendError.queuedFailed')
        : t('chat.sendError.mayStillProcessing');
    const description =
      source === 'queuedAutoSend'
        ? t('chat.sendError.queuedFailedDescription')
        : t('chat.sendError.mayStillProcessingDescription');
    toast.error(message, description ? { description } : undefined);
    if (attachments.length > 0) onRestoreAttachments?.();
    const hasPayload = text.trim().length > 0 || attachments.length > 0;
    let recoveryPersisted = false;
    if (hasPayload && saveRecovery) {
      saveRecovery(text, attachments);
      recoveryPersisted = true;
    }
    return { showedToast: true, message, description, recoveryPersisted };
  }

  // 3. Hard error — preserve the existing fallback to rawMessage.
  const fallback = t('chat.chatInput.toast.messageSendFailed');
  const message = rawMessage.trim() || fallback;
  toast.error(message);
  if (attachments.length > 0) onRestoreAttachments?.();
  return { showedToast: true, message, recoveryPersisted: false };
}

// ---------------------------------------------------------------------------
// Recovery slot helpers — call directly from React components to read / clear.
// ---------------------------------------------------------------------------

/**
 * Persist a recovery slot to sessionStorage so a stuck send can be re-issued
 * after the server actually finishes (or is aborted).
 */
export function saveSendRecovery(text: string, attachments: AttachedFile[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (!text.trim() && attachments.length === 0) {
      window.sessionStorage.removeItem(SEND_ERROR_STORAGE_KEY);
      return;
    }
    const slot: SendRecoverySlot = { text, attachments };
    window.sessionStorage.setItem(SEND_ERROR_STORAGE_KEY, JSON.stringify(slot));
  } catch {
    // Ignore quota and serialization errors — recovery is a best-effort UX.
  }
}

/** Load the recovery slot, or null if absent / malformed. */
export function loadSendRecovery(): SendRecoverySlot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SEND_ERROR_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as SendRecoverySlot).text !== 'string' ||
      !Array.isArray((parsed as SendRecoverySlot).attachments)
    ) {
      return null;
    }
    return {
      text: (parsed as SendRecoverySlot).text,
      attachments: (parsed as SendRecoverySlot).attachments,
    };
  } catch {
    return null;
  }
}

/** Drop the recovery slot after a successful retry. */
export function clearSendRecovery(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SEND_ERROR_STORAGE_KEY);
  } catch {
    // ignore
  }
}
