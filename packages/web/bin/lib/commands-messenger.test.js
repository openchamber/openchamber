import { describe, expect, it } from 'vitest';
import {
  buildMessengerSendRequest,
  validateMessengerSendOptions,
} from './commands-messenger.js';
import { EXIT_CODE } from './cli-errors.js';

describe('messenger send CLI validation', () => {
  it('requires a prompt and exactly one target', () => {
    expect(() => validateMessengerSendOptions({ channel: '123' })).toThrow(/Missing --prompt/);
    expect(() => validateMessengerSendOptions({ prompt: 'done' })).toThrow(/exactly one/);
    expect(() =>
      validateMessengerSendOptions({ prompt: 'done', channel: '123', session: 'ses_1' }),
    ).toThrow(/exactly one/);
  });

  it('validates scheduled timestamps and model references in core logic', () => {
    try {
      validateMessengerSendOptions({
        prompt: 'done',
        channel: '123',
        sendAt: '2020-01-01T00:00Z',
      });
    } catch (err) {
      expect(err.exitCode).toBe(EXIT_CODE.USAGE_ERROR);
      expect(err.message).toMatch(/future/);
    }

    expect(() =>
      validateMessengerSendOptions({ prompt: 'done', channel: '123', model: 'sonnet' }),
    ).toThrow(/provider\/model/);
  });
});

describe('messenger send CLI requests', () => {
  it('builds an immediate post request through the messenger agent API', () => {
    expect(buildMessengerSendRequest({
      prompt: 'Build is green',
      channel: '123',
      notifyOnly: true,
    })).toEqual({
      endpoint: '/api/messenger/agent/post',
      body: {
        channel: '123',
        text: 'Build is green',
        silent: true,
      },
    });
  });

  it('builds a scheduled request through scheduled-task backed agent API', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    expect(buildMessengerSendRequest({
      prompt: 'Run release checks',
      thread: 'https://discord.com/channels/1/2',
      sendAt: future,
      notifyOnly: true,
      model: 'anthropic/claude-sonnet-4',
      agent: 'build',
    })).toEqual({
      endpoint: '/api/messenger/agent/schedule',
      body: {
        channel: 'https://discord.com/channels/1/2',
        text: 'Run release checks',
        sendAt: future,
        notifyOnly: true,
        model: 'anthropic/claude-sonnet-4',
        agent: 'build',
      },
    });
  });
});
