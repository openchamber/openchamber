import { describe, expect, it, vi } from 'vitest';

import {
  buildSessionReferenceForId,
  formatSessionTranscriptMarkdown,
  parseSessionReferenceInput,
  readSessionTranscript,
  resolveSessionReference,
} from './session-reference.js';

describe('parseSessionReferenceInput', () => {
  it('detects session ids', () => {
    expect(parseSessionReferenceInput('ses_abc123')).toEqual({
      kind: 'sessionId',
      sessionId: 'ses_abc123',
      raw: 'ses_abc123',
    });
  });

  it('detects discord urls and snowflakes', () => {
    expect(
      parseSessionReferenceInput('https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333'),
    ).toEqual({
      kind: 'discord',
      channelId: '222222222222222222',
      guildId: '111111111111111111',
      raw: 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
    });

    expect(parseSessionReferenceInput('333333333333333333')).toEqual({
      kind: 'discord',
      channelId: '333333333333333333',
      guildId: null,
      raw: '333333333333333333',
    });
  });
});

describe('formatSessionTranscriptMarkdown', () => {
  it('renders user and assistant messages', () => {
    const markdown = formatSessionTranscriptMarkdown(
      [
        {
          info: { role: 'user', time: { created: Date.parse('2026-01-01T10:00:00Z') } },
          parts: [{ type: 'text', text: 'Hello' }],
        },
        {
          info: { role: 'assistant', time: { created: Date.parse('2026-01-01T10:01:00Z') } },
          parts: [{ type: 'text', text: 'Hi there' }],
        },
      ],
      { title: 'Alpha' },
    );

    expect(markdown).toContain('# Alpha');
    expect(markdown).toContain('**User**');
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('**Assistant**');
    expect(markdown).toContain('Hi there');
  });
});

describe('resolveSessionReference', () => {
  const store = {
    lookupBySessionId: vi.fn((sessionId) =>
      sessionId === 'ses_a'
        ? [{ type: 'discord', targetKey: '333333333333333333', projectPath: '/repo/a', projectLabel: 'A' }]
        : [],
    ),
    findByTargetKey: vi.fn(({ targetKey }) =>
      targetKey === '333333333333333333'
        ? [{ sessionId: 'ses_a', projectPath: '/repo/a' }]
        : [],
    ),
  };

  const opencodeFetch = vi.fn(async (path) => {
    if (path.startsWith('/session/ses_a/message')) {
      return {
        ok: true,
        json: async () => [
          { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'Ping' }] },
        ],
      };
    }
    if (path.startsWith('/session/ses_a')) {
      return {
        ok: true,
        json: async () => ({ id: 'ses_a', title: 'Alpha', directory: '/repo/a' }),
      };
    }
    return { ok: false, json: async () => null };
  });

  it('resolves by session id using bridge binding', async () => {
    const result = await resolveSessionReference({
      input: 'ses_a',
      store,
      readSettings: async () => ({ discord: { guildId: 'guild-1' } }),
      listProjects: async () => [{ path: '/repo/a' }],
      opencodeFetch,
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'ses_a',
      directory: '/repo/a',
      title: 'Alpha',
      reference: 'https://discord.com/channels/guild-1/333333333333333333',
    });
  });

  it('resolves by discord thread id', async () => {
    const result = await resolveSessionReference({
      input: '333333333333333333',
      store,
      readSettings: async () => ({ discord: { guildId: 'guild-1' } }),
      listProjects: async () => [],
      opencodeFetch,
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('ses_a');
  });
});

describe('readSessionTranscript', () => {
  it('returns markdown transcript for a resolved session', async () => {
    const store = {
      lookupBySessionId: vi.fn(() => [
        { type: 'discord', targetKey: '333333333333333333', projectPath: '/repo/a', projectLabel: 'A' },
      ]),
      findByTargetKey: vi.fn(() => []),
    };
    const opencodeFetch = vi.fn(async (path) => {
      if (path.startsWith('/session/ses_a/message')) {
        return {
          ok: true,
          json: async () => [
            { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'Need help' }] },
          ],
        };
      }
      if (path.startsWith('/session/ses_a')) {
        return {
          ok: true,
          json: async () => ({ id: 'ses_a', title: 'Alpha', directory: '/repo/a' }),
        };
      }
      return { ok: false, json: async () => null };
    });

    const result = await readSessionTranscript({
      input: 'ses_a',
      store,
      readSettings: async () => ({ discord: { guildId: 'guild-1' } }),
      listProjects: async () => [{ path: '/repo/a' }],
      opencodeFetch,
    });

    expect(result.ok).toBe(true);
    expect(result.messageCount).toBe(1);
    expect(result.transcript).toContain('Need help');
  });
});

describe('buildSessionReferenceForId', () => {
  it('returns the best copyable reference', async () => {
    const result = await buildSessionReferenceForId({
      sessionId: 'ses_a',
      store: {
        lookupBySessionId: () => [
          { type: 'discord', targetKey: '333333333333333333', projectPath: '/repo/a', projectLabel: 'A' },
        ],
        findByTargetKey: () => [],
      },
      readSettings: async () => ({ discord: { guildId: 'guild-1' } }),
      listProjects: async () => [{ path: '/repo/a' }],
      opencodeFetch: async (path) => {
        if (path.startsWith('/session/ses_a')) {
          return { ok: true, json: async () => ({ id: 'ses_a', title: 'Alpha', directory: '/repo/a' }) };
        }
        return { ok: false, json: async () => null };
      },
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'ses_a',
      reference: 'https://discord.com/channels/guild-1/333333333333333333',
      discordUrl: 'https://discord.com/channels/guild-1/333333333333333333',
      shareUrl: null,
      title: 'Alpha',
      directory: '/repo/a',
      projectLabel: 'A',
    });
  });
});
