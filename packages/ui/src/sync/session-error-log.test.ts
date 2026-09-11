import { describe, expect, test } from 'bun:test';
import { getRecentSessionErrors, recordSessionError, summarizeOpenCodeError } from './session-error-log';

describe('summarizeOpenCodeError', () => {
  test('reads the OpenCode shape: name plus data.message', () => {
    expect(summarizeOpenCodeError({ name: 'ProviderAuthError', data: { providerID: 'openai', message: 'Invalid API key' } }))
      .toEqual({ name: 'ProviderAuthError', message: 'Invalid API key' });
  });

  test('falls back to a top-level message and reports missing details as null', () => {
    expect(summarizeOpenCodeError({ message: 'socket hang up' })).toEqual({ name: null, message: 'socket hang up' });
    expect(summarizeOpenCodeError({ name: 'UnknownError', data: { message: '   ' } })).toEqual({ name: 'UnknownError', message: null });
    expect(summarizeOpenCodeError(undefined)).toEqual({ name: null, message: null });
  });

  test('bounds the message length', () => {
    const summary = summarizeOpenCodeError({ name: 'UnknownError', data: { message: 'x'.repeat(1000) } });
    expect(summary.message?.length).toBe(400);
  });
});

describe('recordSessionError', () => {
  test('keeps the newest records first and caps the buffer', () => {
    for (let index = 0; index < 25; index += 1) {
      recordSessionError({ sessionId: `ses_${index}`, directory: null, name: 'UnknownError', message: `error ${index}` });
    }
    const records = getRecentSessionErrors();
    expect(records.length).toBe(20);
    expect(records[0]?.sessionId).toBe('ses_24');
    expect(records[19]?.sessionId).toBe('ses_5');
  });
});
