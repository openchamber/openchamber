import { describe, expect, it } from 'vitest';
import { excerpt, loadAssistContext, newestContentId } from './context.js';
import { buildAssistPrompt } from './prompt.js';

// v2 message records are flat and a page lists them newest first.
const user = (id, text, extra = {}) => ({ id, type: 'user', text, ...extra });
const assistant = (id, text, extra = {}) => ({
  id,
  type: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  finish: 'stop',
  time: { completed: 1 },
  model: { providerID: 'provider', id: 'model' },
  ...extra,
});
const synthetic = (id, text, extra = {}) => ({ id, type: 'synthetic', text, ...extra });
// OpenCode closes every turn with an idle marker; a switch is appended when
// the user changes model or agent between turns.
const idle = (id, outcome = 'succeeded') => ({ id, type: 'idle', outcome, time: { created: 2 } });
const modelSwitch = (id) => ({ id, type: 'model-switched', model: { providerID: 'p', id: 'm' } });

const pair = (id) => [user(`u${id}`, `request ${id}`), assistant(`a${id}`, `answer ${id}`)];

/** `data` is given oldest-first here and reversed, the way OpenCode serves it. */
const page = (data, next = null) => ({ data: [...data].reverse(), cursor: next ? { next } : {} });
const load = (readPage) => loadAssistContext({ readPage, signal: new AbortController().signal });

describe('session assist context', () => {
  it('stops paging at three human turns and excludes tools and injected instructions', async () => {
    let calls = 0;
    const records = [...pair(1), ...pair(2), ...pair(3), ...pair(4)];
    records.at(-1).content.push(
      { type: 'tool', tool: 'bash', state: { output: 'TOOL_PAYLOAD' } },
    );
    const context = await load(async ({ limit, cursor }) => {
      calls++;
      expect(limit).toBe(50);
      expect(cursor).toBeUndefined();
      return page(records, 'more');
    });
    expect(calls).toBe(1);
    expect(context.turns.map((t) => t.user.id)).toEqual(['u2', 'u3', 'u4']);
    expect(context.last.text).toBe('answer 4');
    expect(JSON.stringify(context)).not.toContain('TOOL_PAYLOAD');
  });

  it('finds the real user across a page boundary and past a compaction', async () => {
    // v2 gives compaction its own message role instead of an assistant message
    // flagged `summary`.
    const compaction = { id: 'summary', type: 'compaction', status: 'completed', summary: 'INTERNAL SUMMARY' };
    const final = assistant('final', 'All requested work done');
    const context = await load(async ({ cursor }) => (cursor
      ? page([...pair(1), ...pair(2), user('human', 'Finish the requested work')])
      : page([compaction, final], 'older')));
    expect(context.last.id).toBe('final');
    expect(context.turns.at(-1).user.id).toBe('human');
    expect(context.turns.at(-1).assistant.id).toBe('final');
    expect(JSON.stringify(context)).not.toContain('INTERNAL SUMMARY');
  });

  it('retains interrupted requests as progress, not as completed turns', async () => {
    const context = await load(async () => page([
      user('u1', 'Implement both fixes'),
      assistant('a1', 'First fix done', { finish: 'tool-calls' }),
      ...pair(2),
    ]));
    expect(context.turns[0].complete).toBe(false);
    expect(context.turns[0].assistant.text).toBe('First fix done');
    expect(context.turns[1].complete).toBe(true);
  });

  it('folds an attached synthetic into the user message it belongs to', async () => {
    // v1 carried an attachment as a synthetic part of the user message; v2
    // sends it as its own turn just before the prompt.
    const attachment = synthetic('s', 'Serialized attachment', {
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'English quoted source', text: 'Виправ саме це' } },
    });
    const context = await load(async () => page([attachment, user('u', 'Fix it'), assistant('a', 'Done')]));
    expect(context.turns).toHaveLength(1);
    expect(context.turns[0].user.text).toContain('> English quoted source');
    expect(context.turns[0].user.text).toContain('User comment:\nВиправ саме це');
    expect(context.turns[0].user.text).toContain('Fix it');
    expect(context.turns[0].user.authored).toContain('Виправ саме це');
  });

  it('retains the comment after a large quote and the conclusion after a long answer', async () => {
    const attachment = synthetic('s', 'attachment', {
      metadata: {
        openchamberContext: { kind: 'browser-annotation', prompt: 'x'.repeat(30_000), text: 'USER_REQUEST_END' },
      },
    });
    const context = await load(async () => page([
      attachment,
      user('u', 'Look at this'),
      assistant('a', `START${'x'.repeat(30_000)}CONCLUSION`),
    ]));
    expect(context.turns[0].user.text).toContain('USER_REQUEST_END');
    expect(context.last.text).toMatch(/^START/);
    expect(context.last.text).toMatch(/CONCLUSION$/);
    expect(context.last.text.length).toBeLessThanOrEqual(16_000);
  });

  it('fails explicitly on malformed annotation text instead of losing the comment', async () => {
    const attachment = synthetic('s', 'attachment', {
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'source', text: 42 } },
    });
    await expect(load(async () => page([attachment, user('u', 'Fix'), assistant('a', 'done')]))).rejects.toThrow();
  });

  it('does not treat a failed or repeated page as complete history', async () => {
    await expect(load(async () => ({ data: undefined }))).rejects.toThrow('unavailable');
    await expect(load(async () => page(pair(1), 'repeated'))).rejects.toThrow('no progress');
    let calls = 0;
    await expect(load(async () => {
      if (++calls === 2) throw new Error('offline');
      return page(pair(1), 'next');
    })).rejects.toThrow('offline');
  });

  it('bounds retrieval and refuses to invent a user for an orphaned answer', async () => {
    let calls = 0;
    const context = await load(async () => page([assistant(`a${++calls}`, 'answer')], `cursor${calls}`));
    expect(calls).toBe(8);
    expect(context).toBeNull();
  });

  it('looks past the idle marker that closes a finished turn', async () => {
    // The ordinary v2 transcript: answer, then `idle`, possibly followed by a
    // switch the user made afterwards. The answer is still the last message.
    for (const tail of [[idle('i')], [idle('i'), modelSwitch('m')], [modelSwitch('m'), idle('i')]]) {
      const context = await load(async () => page([...pair(1), ...tail]));
      expect(context?.last.id).toBe('a1');
      expect(context.turns).toHaveLength(1);
      expect(context.turns[0].assistant.id).toBe('a1');
    }
  });

  it('keeps an attachment glued to its prompt across a switch, and a turn across an idle', async () => {
    const attachment = synthetic('s', 'Attached note');
    const context = await load(async () => page([
      ...pair(1), idle('i1'),
      attachment, modelSwitch('m'), user('u2', 'Use the note'), assistant('a2', 'Used'), idle('i2'),
    ]));
    expect(context.turns.map((turn) => turn.user.id)).toEqual(['u1', 'u2']);
    expect(context.turns[1].user.text).toBe('Attached note\n\nUse the note');
    expect(context.turns[0].complete).toBe(true);
  });

  it('treats a failed or interrupted idle as evidence the turn did not finish', async () => {
    for (const outcome of ['failed', 'interrupted']) {
      expect(await load(async () => page([...pair(1), idle('i', outcome)]))).toBeNull();
    }
  });

  it('keeps paging when a page holds only service records', async () => {
    const context = await load(async ({ cursor }) => (cursor
      ? page([...pair(1)])
      : page([idle('i1'), modelSwitch('m'), idle('i2')], 'older')));
    expect(context?.last.id).toBe('a1');
  });

  it('names the newest content record of a newest-first page', () => {
    expect(newestContentId([idle('i'), modelSwitch('m'), assistant('a', 'x'), user('u', 'y')])).toBe('a');
    expect(newestContentId([idle('i', 'failed'), assistant('a', 'x')])).toBe('i');
    expect(newestContentId([idle('i')])).toBeNull();
    expect(newestContentId(undefined)).toBeNull();
  });

  it('skips unfinished, failed, compaction, and user tails', async () => {
    for (const tail of [
      user('tail', 'New request'),
      assistant('tail', 'Working', { finish: 'tool-calls' }),
      assistant('tail', 'Failed', { error: { type: 'APIError', message: 'boom' } }),
      { id: 'tail', type: 'compaction', status: 'completed', summary: 'Summary' },
    ]) expect(await load(async () => page([...pair(1), tail]))).toBeNull();
  });

  it('keeps both sides of the newest exchange within a small model budget', async () => {
    const context = await load(async () => page([
      ...pair(1),
      ...pair(2),
      user('latest', `REQUEST_START${'u'.repeat(8000)}REQUEST_END`),
      assistant('answer', `ANSWER_START${'a'.repeat(16000)}ANSWER_END`),
    ]));
    for (const budget of [1_000, 4_000, 14_000, 32_000, 1_000_000]) {
      const prompt = buildAssistPrompt(context.turns, { recap: true, suggestion: true }, budget);
      expect(prompt.text.length).toBeLessThanOrEqual(Math.min(budget, 32_000));
      for (const marker of ['REQUEST_START', 'REQUEST_END', 'ANSWER_START', 'ANSWER_END']) expect(prompt.text).toContain(marker);
    }
    expect(buildAssistPrompt(context.turns, { recap: true }, 500)).toBeNull();
  });

  it('excerpts from both ends so the start and the end both survive', () => {
    expect(excerpt('abcdef', 10)).toBe('abcdef');
    const trimmed = excerpt(`START${'x'.repeat(500)}END`, 100);
    expect(trimmed.length).toBeLessThanOrEqual(100);
    expect(trimmed).toMatch(/^START/);
    expect(trimmed).toMatch(/END$/);
  });
});
