import { afterEach, describe, expect, it, vi } from 'vitest';

import { summarizeText } from './summarization.js';

const originalFetch = globalThis.fetch;

function stubFetch(fetchMock) {
  globalThis.fetch = fetchMock;
}

describe('text summarization zen requests', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses responses endpoint for gpt models', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Short summary' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 100,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/responses',
      expect.objectContaining({
        body: expect.stringContaining('"input"'),
      }),
    );
    expect(result.summary).toBe('Short summary');
  });

  it('uses chat completions endpoint for openai-compatible zen models', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Chat summary' } }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 100,
      zenModel: 'big-pickle',
      mode: 'notification',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"messages"'),
      }),
    );
    expect(result.summary).toBe('Chat summary');
  });

  it('clamps successful model summaries to the requested max length', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'This response is too long' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 12,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(result.summary).toBe('This respons');
    expect(result.summaryLength).toBe(12);
  });

  it('does not clamp successful model summaries for non-finite max lengths', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Full response' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: Infinity,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(result.summary).toBe('Full response');
    expect(result.summaryLength).toBe(13);
  });
});
