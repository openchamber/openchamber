import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, StructuredError } from '@/lib/opencode/model';

import { assistantErrorNotice, isStoppedTurnError, STOPPED_TURN_MESSAGE } from './assistantError';

const assistant = (error?: StructuredError): AssistantMessage => ({
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1 },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
  error,
});

describe('isStoppedTurnError', () => {
  test('reads the abort OpenCode records for a stopped step as a stop', () => {
    // Pressing Stop makes OpenCode record an error on the assistant message:
    // type `MessageAbortedError`, message "Step interrupted". It is not a send
    // failure, so the transcript must not call it one.
    expect(isStoppedTurnError('MessageAbortedError', 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError('MessageAbortedError', '')).toBe(true);
  });

  test('recognises the interruption by its message when only the v2 type survives', () => {
    // A reload projects the stored error, which carries `type` but no `name`;
    // the detail is all the classifier sees.
    expect(isStoppedTurnError(undefined, 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError(undefined, 'Step interrupted.')).toBe(true);
  });

  test('keeps the locally synthesized stop shape', () => {
    // `interruptedTurnToolParts` closes an interrupted turn itself with
    // `{ type: "aborted", message: "aborted" }`.
    expect(isStoppedTurnError(undefined, 'aborted')).toBe(true);
    expect(isStoppedTurnError(undefined, '  ABORTED  ')).toBe(true);
  });

  test('leaves a real failure that merely mentions aborting as a failure', () => {
    // A dropped connection is not the user pressing Stop, and telling them it
    // was would hide the reason their turn ended.
    expect(isStoppedTurnError(undefined, 'Connection aborted')).toBe(false);
    expect(isStoppedTurnError('UnknownError', 'Stream aborted by the provider')).toBe(false);
    expect(isStoppedTurnError(undefined, 'Model unavailable')).toBe(false);
  });

  test('offers the neutral sentence a stopped turn is shown with', () => {
    expect(STOPPED_TURN_MESSAGE).toBe('The running turn was stopped before OpenCode could send the next message.');
  });
});

describe('assistantErrorNotice', () => {
  test('does not call a stopped turn a failed send', () => {
    // The reported symptom: Stop produced "Opencode failed to send message
    // with error: Step interrupted" even though the message was delivered and
    // the user stopped the step on purpose.
    const notice = assistantErrorNotice(assistant({ type: 'MessageAbortedError', message: 'Step interrupted' }));
    expect(notice).toEqual({ text: STOPPED_TURN_MESSAGE });
    expect(notice?.text).not.toContain('failed to send');
  });

  test('keeps the stop sentence for the local close this client writes', () => {
    expect(assistantErrorNotice(assistant({ type: 'aborted', message: 'aborted' })))
      .toEqual({ text: STOPPED_TURN_MESSAGE });
  });

  test('still names a real failure as one', () => {
    expect(assistantErrorNotice(assistant({ type: 'UnknownError', message: 'Model unavailable' })))
      .toEqual({ text: 'Opencode failed to send message with error: Model unavailable' });
  });

  test('keeps the retry notice ahead of the stop classification', () => {
    expect(assistantErrorNotice(assistant({ type: 'SessionRetry', message: 'Retrying in 5s' })))
      .toEqual({ text: 'Opencode failed to send a message. Retry attempt info: Retrying in 5s' });
  });

  test('names an authentication failure the way the rest of the product does', () => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderAuthError', message: 'invalid token' })))
      .toEqual({ text: 'Authentication failed for this provider. Please re-authenticate and retry.' });
  });

  test('shows nothing for a message without an error', () => {
    expect(assistantErrorNotice(assistant())).toBeNull();
  });
});
