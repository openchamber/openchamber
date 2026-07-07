/**
 * Unit tests for the shared send-error handler.
 *
 * These tests assert that the bug from issue #2072 (silent soft-error swallow
 * when no attachments were present) is fixed: every soft network error must
 * surface a toast, regardless of attachment state.
 *
 * The handler is pure — it accepts the toast function and i18n lookup as
 * dependencies so we can exercise every branch without React or DOM.
 */
import { describe, expect, test } from 'bun:test';
import {
  SOFT_NETWORK_PATTERNS,
  SOFT_NETWORK_EXACT,
  classifySendError,
  clearSendRecovery,
  handleSendError,
  loadSendRecovery,
  saveSendRecovery,
} from './sendErrorHandler';
import type { AttachedFile } from '@/stores/types/sessionTypes';

interface ToastCall {
  message: string;
  description?: string;
}

function makeToaster(): { calls: ToastCall[]; toast: { error: (m: string, o?: { description?: string }) => void } } {
  const calls: ToastCall[] = [];
  return {
    calls,
    toast: {
      error: (message, options) => {
        calls.push({ message, description: options?.description });
      },
    },
  };
}

const passthroughT = (key: string): string => key;

const fixtureAttachment: AttachedFile = {
  filename: 'note.txt',
} as AttachedFile;

describe('classifySendError', () => {
  test('matches every documented soft-network pattern', () => {
    for (const pattern of SOFT_NETWORK_PATTERNS) {
      const result = classifySendError(`something ${pattern} happened`);
      expect(result.isSoftNetwork).toBe(true);
      expect(result.attachmentsTooLarge).toBe(false);
    }
  });

  test('matches the exact lowercased "failed to send message"', () => {
    const result = classifySendError('failed to send message');
    expect(result.isSoftNetwork).toBe(true);
    for (const exact of SOFT_NETWORK_EXACT) {
      expect(classifySendError(exact).isSoftNetwork).toBe(true);
    }
  });

  test('does NOT classify normal errors as soft network', () => {
    const result = classifySendError('Some other random error');
    expect(result.isSoftNetwork).toBe(false);
    expect(result.attachmentsTooLarge).toBe(false);
  });

  test('detects "payload too large" / 413 / entity too large', () => {
    for (const msg of ['payload too large', '413 forbidden', 'entity too large']) {
      const result = classifySendError(msg);
      expect(result.attachmentsTooLarge).toBe(true);
    }
  });

  test('matching is case-insensitive', () => {
    const result = classifySendError('GATEWAY TIMEOUT');
    expect(result.isSoftNetwork).toBe(true);
  });
});

describe('handleSendError — issue #2072 silent failure fix', () => {
  test('soft network error with NO attachments ALWAYS shows a toast', () => {
    const { calls, toast } = makeToaster();
    let recoveryPersisted = false;
    const result = handleSendError({
      rawMessage: 'timeout',
      text: 'hello world',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
      saveRecovery: () => {
        recoveryPersisted = true;
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].message).toBe('chat.sendError.mayStillProcessing');
    expect(calls[0].description).toBe('chat.sendError.mayStillProcessingDescription');
    expect(result.showedToast).toBe(true);
    expect(recoveryPersisted).toBe(true);
  });

  test('soft network error WITHOUT text or attachments does not save a recovery slot', () => {
    const { toast } = makeToaster();
    let saveCalled = false;
    handleSendError({
      rawMessage: 'failed to fetch',
      text: '',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
      saveRecovery: () => {
        saveCalled = true;
      },
    });
    expect(saveCalled).toBe(false);
  });

  test('soft network error WITH attachments restores attachments to the composer', () => {
    const { calls, toast } = makeToaster();
    let restoreCalled = false;
    handleSendError({
      rawMessage: 'timeout',
      text: 'hi',
      attachments: [fixtureAttachment],
      source: 'send',
      toast,
      t: passthroughT,
      onRestoreAttachments: () => {
        restoreCalled = true;
      },
    });
    expect(restoreCalled).toBe(true);
    // The bug fix unifies the copy across attachment states — soft network
    // errors always surface the "may still be processing" message so the
    // user understands the actual cause of the failure.
    expect(calls[0].message).toBe('chat.sendError.mayStillProcessing');
  });

  test('attachments too large path keeps its existing copy and restores attachments', () => {
    const { calls, toast } = makeToaster();
    let restoreCalled = false;
    handleSendError({
      rawMessage: 'payload too large',
      text: 'long content',
      attachments: [fixtureAttachment],
      source: 'send',
      toast,
      t: passthroughT,
      onRestoreAttachments: () => {
        restoreCalled = true;
      },
    });
    expect(calls[0].message).toBe('chat.chatInput.toast.attachmentsTooLarge');
    expect(restoreCalled).toBe(true);
  });

  test('hard / unknown error falls through to rawMessage toast', () => {
    const { calls, toast } = makeToaster();
    handleSendError({
      rawMessage: 'Service responded with: something exploded',
      text: 'hi',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].message).toBe('Service responded with: something exploded');
  });

  test('empty rawMessage in hard-error path falls back to localized key', () => {
    const { calls, toast } = makeToaster();
    handleSendError({
      rawMessage: '',
      text: 'hi',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
    });
    expect(calls[0].message).toBe('chat.chatInput.toast.messageSendFailed');
  });

  test('queuedAutoSend source uses queued-failed copy', () => {
    const { calls, toast } = makeToaster();
    handleSendError({
      rawMessage: 'timeout',
      text: '',
      attachments: [],
      source: 'queuedAutoSend',
      toast,
      t: passthroughT,
    });
    expect(calls[0].message).toBe('chat.sendError.queuedFailed');
    expect(calls[0].description).toBe('chat.sendError.queuedFailedDescription');
  });

  test('saveRecovery is invoked only when there is something to recover', () => {
    const { toast } = makeToaster();
    let recoveryCalls = 0;
    const saveRecovery = () => {
      recoveryCalls += 1;
    };

    handleSendError({
      rawMessage: 'timeout',
      text: 'lorem',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
      saveRecovery,
    });
    expect(recoveryCalls).toBe(1);

    handleSendError({
      rawMessage: 'timeout',
      text: '',
      attachments: [],
      source: 'send',
      toast,
      t: passthroughT,
      saveRecovery,
    });
    expect(recoveryCalls).toBe(1); // unchanged — no payload
  });
});

describe('recovery slot sessionStorage helpers', () => {
  // sessionStorage is browser-only; under bun:test window is undefined so the
  // helpers are no-ops. Skip gracefully rather than failing in the test env.
  // Using a runtime `if (!hasDOM) return;` because TypeScript's bun:test types
  // do not surface the runtime `skipIf` helper.
  const hasDOM = typeof window !== 'undefined';

  test('saveSendRecovery / loadSendRecovery round-trip', () => {
    if (!hasDOM) return;
    saveSendRecovery('hello', [fixtureAttachment]);
    const loaded = loadSendRecovery();
    expect(loaded?.text).toBe('hello');
    expect(loaded?.attachments).toHaveLength(1);
    clearSendRecovery();
    expect(loadSendRecovery()).toBeNull();
  });

  test('saveSendRecovery clears storage when called with empty payload', () => {
    if (!hasDOM) return;
    saveSendRecovery('something', [fixtureAttachment]);
    expect(loadSendRecovery()).not.toBeNull();
    saveSendRecovery('', []);
    expect(loadSendRecovery()).toBeNull();
  });
});
