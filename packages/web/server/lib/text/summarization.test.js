import { describe, expect, it } from 'vitest';

import { sanitizeForNote, sanitizeForTTS, summarizeText } from './summarization.js';

describe('text summarization stubs', () => {
  it('removes code from TTS text before stripping markdown punctuation', () => {
    expect(sanitizeForTTS('Read `const value = 1` aloud')).toBe('Read aloud');
    expect(sanitizeForTTS('Before\n```js\nconst value = 1\n```\nAfter')).toBe('Before After');
  });

  it('rejects non-string input at the public sanitizer boundary', () => {
    for (const text of [undefined, null, false, 0, 42, {}, [], new String('text')]) {
      expect(sanitizeForTTS(text)).toBe('');
      expect(sanitizeForNote(text)).toBe('');
    }
    expect(sanitizeForTTS('[hello] {world} (again)')).toBe('hello world again');
  });

  it('preserves missing text and the threshold result fields', async () => {
    for (const text of [undefined, null, '']) {
      expect(await summarizeText({ text })).toEqual({
        summary: '',
        summarized: false,
        reason: 'No text provided',
      });
    }
    expect(await summarizeText({ text: 'Hello', threshold: 5 })).toEqual({
      summary: 'Hello',
      summarized: false,
      reason: 'Text under threshold',
    });
  });

  it('uses TTS sanitization for an unrecognized mode', async () => {
    expect(await summarizeText({ text: '**Hello** `code`', threshold: 0, mode: 'other' })).toEqual({
      summary: 'Hello',
      summarized: false,
      reason: 'Model summarization provider unavailable',
      originalLength: 16,
      summaryLength: 5,
    });
  });

  it('preserves note clause splitting and an empty first clause', async () => {
    expect((await summarizeText({ text: 'In summary: Keep this; omit that, too.', mode: 'note' })).summary)
      .toBe('Keep this');
    expect((await summarizeText({ text: '; next clause', mode: 'note' })).summary).toBe('');
    expect((await summarizeText({ text: ', next phrase', mode: 'note' })).summary).toBe('');
  });

  it('does not call the retired zen provider', async () => {
    const result = await summarizeText({
      text: 'The implementation now correctly loads notification templates before dispatching the notification. It also fetches the latest assistant message when the event payload does not include message parts. This should make completion notifications match user settings.',
      threshold: 0,
      maxLength: 80,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe('Model summarization provider unavailable');
    expect(result.summary).toBe('The implementation now correctly loads notification templates before dispatchin…');
  });

  it('returns local note fallback while provider is unavailable', async () => {
    const result = await summarizeText({
      text: 'First sentence. Second sentence with the useful insight.',
      threshold: 0,
      maxLength: 100,
      mode: 'note',
    });

    expect(result).toMatchObject({
      summary: 'First sentence.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });
});
