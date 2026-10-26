import { describe, expect, test } from 'bun:test';

import { CONTENT_SHELL_METADATA_KEY, parsePartShellsHeader, shellMessagePage } from './message-shells.js';

const tool = (name, state, extra = {}) => ({
  type: 'tool',
  id: `call_${name}`,
  name,
  time: { created: 1, ran: 2, completed: 3 },
  state,
  ...extra,
});

const completed = (overrides = {}) => ({
  status: 'completed',
  input: { command: 'ls -la', path: '/repo' },
  content: [{ type: 'text', text: 'line one\n' }, { type: 'text', text: 'line two' }],
  metadata: { exit: 0, output: 'line one\nline two', files: [{ file: 'a.ts', additions: 2, deletions: 1 }] },
  ...overrides,
});

const page = (content, message = {}) => ({
  data: [{ id: 'msg_1', type: 'assistant', time: { created: 1 }, content, ...message }],
  cursor: { next: 'c1' },
});

describe('parsePartShellsHeader', () => {
  test('reads the version and the tools kept whole', () => {
    expect(parsePartShellsHeader('v1')).toEqual(new Set());
    expect(parsePartShellsHeader('v1, shell ,edit')).toEqual(new Set(['shell', 'edit']));
  });

  test('ignores a missing header and unknown versions', () => {
    expect(parsePartShellsHeader(undefined)).toBeNull();
    expect(parsePartShellsHeader('v2,shell')).toBeNull();
    expect(parsePartShellsHeader('shell')).toBeNull();
  });
});

describe('shellMessagePage', () => {
  test('replaces a finished result with a marker and keeps what the collapsed row reads', () => {
    const result = shellMessagePage(page([tool('shell', completed(), { native: { a: 1, b: 2 } })]), new Set());
    const part = result.data[0].content[0];
    expect(part.state.content).toEqual([{ type: 'text', text: '' }]);
    expect(part.state.input).toEqual({ command: 'ls -la', path: '/repo' });
    expect(part.state.metadata).toEqual({
      exit: 0,
      files: [{ file: 'a.ts', additions: 2, deletions: 1 }],
      [CONTENT_SHELL_METADATA_KEY]: { chars: 17 },
    });
    expect(part.time).toEqual({ created: 1, ran: 2, completed: 3 });
    expect('native' in part).toBe(false);
    expect('providerResultState' in part).toBe(false);
    expect(result.cursor).toEqual({ next: 'c1' });
  });

  test('keeps the error of a failed call and shells its partial output', () => {
    const error = { type: 'unknown', message: 'exit 1' };
    const part = shellMessagePage(page([tool('shell', completed({ status: 'error', error }))]), new Set()).data[0].content[0];
    expect(part.state.error).toEqual(error);
    expect(part.state.content).toEqual([{ type: 'text', text: '' }]);
    expect(part.state.metadata[CONTENT_SHELL_METADATA_KEY]).toEqual({ chars: 17 });
  });

  test('leaves running calls, kept tools and subagent calls whole', () => {
    const running = tool('shell', { status: 'running', input: {}, metadata: { output: 'partial' } });
    const kept = tool('grep', completed());
    const subagent = tool('subagent', completed());
    const parts = shellMessagePage(page([running, kept, subagent, tool('edit', completed())]), new Set(['grep'])).data[0].content;
    expect(parts[0].state).toEqual(running.state);
    expect(parts[1].state).toEqual(kept.state);
    expect(parts[2].state).toEqual(subagent.state);
    expect(parts[3].state).toEqual(completed());
  });

  test('does not mark a call that had no result to leave out', () => {
    const part = shellMessagePage(page([tool('glob', completed({ content: [], metadata: { count: 0 } }))]), new Set()).data[0].content[0];
    expect(part.state.metadata).toEqual({ count: 0 });
  });

  test('drops fields no client reads and leaves other parts alone', () => {
    const text = { type: 'text', text: 'hello' };
    const signedText = { type: 'text', text: 'signed', native: { itemId: 'i' } };
    const reasoning = { type: 'reasoning', text: 'thinking', native: { encrypted: 'x'.repeat(100) }, time: { created: 1 } };
    const result = shellMessagePage(
      page([text, signedText, reasoning], { native: { responseId: 'r' }, rawFinish: 'stop', snapshot: { start: 'a', end: 'b' } }),
      new Set(),
    );
    const message = result.data[0];
    expect(message.content[0]).toBe(text);
    expect(message.content[1]).toEqual({ type: 'text', text: 'signed' });
    expect(message.content[2]).toEqual({ type: 'reasoning', text: 'thinking', time: { created: 1 } });
    expect('native' in message || 'rawFinish' in message || 'snapshot' in message).toBe(false);
  });

  test('passes through anything that is not a message page', () => {
    const error = { error: 'not found' };
    expect(shellMessagePage(error, new Set())).toBe(error);
  });
});
