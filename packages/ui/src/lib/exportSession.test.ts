import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/opencode/model';
import { createContextPart } from '@/lib/messages/contextParts';
import { downloadAsMarkdown, formatSessionAsMarkdown } from './exportSession';

const text = (messageID: string, content: string): Part => ({
  id: `${messageID}-text`, sessionID: 'session', messageID, type: 'text', text: content,
});

type SessionRecord = { info: Message; parts: Part[] };

const user = (): SessionRecord => ({
  info: { id: 'u1', sessionID: 'session', role: 'user', time: { created: 1 } },
  parts: [text('u1', 'Fix the build')],
});

const answer = (variant?: string): SessionRecord => ({
  info: {
    id: 'a1', sessionID: 'session', role: 'assistant', agent: 'build',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', variant, time: { created: 2, completed: 3 },
  },
  parts: [text('a1', 'Fixed it')],
});

const assistantDetails = (markdown: string): string[] =>
  [...markdown.matchAll(/\*\*Assistant\*\*\n\n\*[^*]*\(([^)]*)\)\*/g)].map((match) => match[1]);

describe('session export', () => {
  test('defers Blob URL revocation after downloading the complete Markdown', async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const events: string[] = [];
    let blob: Blob | undefined;
    let revoke: (() => void) | undefined;
    let delay: number | undefined;
    const anchor = {
      href: '',
      download: '',
      click: () => events.push('click'),
    };

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: {
          appendChild: () => events.push('append'),
          removeChild: () => events.push('remove'),
        },
        createElement: () => anchor,
      },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (value: Blob) => {
        blob = value;
        events.push('create-url');
        return 'blob:session-export';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => events.push('revoke'),
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (callback: () => void, milliseconds: number) => {
        revoke = callback;
        delay = milliseconds;
        events.push('schedule-revoke');
        return 0;
      },
    });

    try {
      downloadAsMarkdown('# Complete export\n\nAll message content', 'session.md');

      expect(anchor.href).toBe('blob:session-export');
      expect(anchor.download).toBe('session.md');
      expect(events).toEqual(['create-url', 'append', 'click', 'remove', 'schedule-revoke']);
      expect(delay).toBe(100);
      expect(await blob?.text()).toBe('# Complete export\n\nAll message content');

      revoke?.();
      expect(events.at(-1)).toBe('revoke');
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
      if (originalSetTimeout) Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout);
    }
  });

  test('exports attached context as context and drops server prompt plumbing', () => {
    const attached: SessionRecord = {
      info: {
        id: 's1', sessionID: 'session', role: 'synthetic', time: { created: 0 },
        ...createContextPart({ kind: 'chat-quote', quote: 'Earlier answer', text: 'Fix this detail' }),
      },
      parts: [],
    };
    const plumbing: SessionRecord = {
      info: { id: 's2', sessionID: 'session', role: 'synthetic', time: { created: 0 }, text: 'The user is returning after a break.' },
      parts: [],
    };

    const markdown = formatSessionAsMarkdown([plumbing, attached, user(), answer()], 'Session');

    expect(markdown).toContain('**Context**');
    expect(markdown).toContain('Fix this detail');
    expect(markdown).not.toContain('returning after a break');
    expect(markdown).toContain('Fixed it');
  });

  test('names the thinking level next to the model for the main agent and sub-agents', () => {
    const child = { title: 'Explore', agent: 'explore', records: [answer('max')], children: [] };

    const markdown = formatSessionAsMarkdown([user(), answer('high')], 'Session', [child]);

    expect(assistantDetails(markdown)).toEqual([
      'anthropic/claude-opus-4-1, thinking: high',
      'anthropic/claude-opus-4-1, thinking: max',
    ]);
  });

  test('keeps the model alone when no thinking level was picked', () => {
    const markdown = [undefined, 'default', 'none']
      .map((variant) => formatSessionAsMarkdown([answer(variant)], 'Session'))
      .join('\n');

    expect(assistantDetails(markdown)).toEqual([
      'anthropic/claude-opus-4-1',
      'anthropic/claude-opus-4-1',
      'anthropic/claude-opus-4-1',
    ]);
  });
});
