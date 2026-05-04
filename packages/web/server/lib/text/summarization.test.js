import { afterEach, describe, expect, it, vi } from 'vitest';

import { summarizeText } from './summarization.js';

describe('text summarization zen requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    vi.stubGlobal('fetch', fetchMock);

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
    vi.stubGlobal('fetch', fetchMock);

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
});
