import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/opencode/model';
import { createContextPart } from '@/lib/messages/contextParts';
import { formatSessionAsMarkdown } from './exportSession';

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
