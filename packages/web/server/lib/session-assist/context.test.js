import { describe, expect, it } from 'vitest';
import { excerpt, loadAssistContext } from './context.js';
import { buildAssistPrompt } from './prompt.js';

const record = (id, role, text, extra = {}, parts = []) => ({
  info: { id, role, parentID: 'user', finish: 'stop', time: { completed: 1 }, providerID: 'provider', modelID: 'model', ...extra },
  parts: [...(text ? [{ type: 'text', text }] : []), ...parts],
});
const pair = (id) => [record(`u${id}`, 'user', `request ${id}`), record(`a${id}`, 'assistant', `answer ${id}`, { parentID: `u${id}` })];
const page = (data, cursor = '') => ({ data, response: { headers: new Headers({ 'x-next-cursor': cursor }) } });
const load = (readPage) => loadAssistContext({ readPage, signal: new AbortController().signal });

describe('session assist context', () => {
  it('stops paging at three human turns and excludes tools and injected instructions', async () => {
    let calls = 0;
    const records = [...pair(1), ...pair(2), ...pair(3), ...pair(4)];
    records.at(-1).parts.push({ type: 'tool', state: { output: 'TOOL_PAYLOAD' } }, { type: 'text', synthetic: true, text: 'INJECTED_PROMPT' });
    const context = await load(async ({ limit, before }) => {
      calls++;
      expect(limit).toBe(50);
      expect(before).toBeUndefined();
      return page(records, 'more');
    });
    expect(calls).toBe(1);
    expect(context.turns.map((t) => t.user.id)).toEqual(['u2', 'u3', 'u4']);
    expect(context.last.text).toBe('answer 4');
    expect(JSON.stringify(context)).not.toContain('TOOL_PAYLOAD');
    expect(JSON.stringify(context)).not.toContain('INJECTED_PROMPT');
  });

  it('finds the real user across a page boundary and compaction continuations', async () => {
    const summary = record('summary', 'assistant', 'INTERNAL SUMMARY', { summary: true });
    const continuation = record('continuation', 'user', '', {}, [{ type: 'text', synthetic: true, text: 'Continue' }]);
    const final = record('final', 'assistant', 'All requested work done', { parentID: 'continuation' });
    const context = await load(async ({ before }) => before
      ? page([...pair(1), ...pair(2), record('human', 'user', 'Finish the requested work')])
      : page([summary, continuation, final], 'older'));
    expect(context.last.id).toBe('final');
    expect(context.turns.at(-1).user.id).toBe('human');
    expect(context.turns.at(-1).assistant.id).toBe('final');
    expect(JSON.stringify(context)).not.toContain('INTERNAL SUMMARY');
  });

  it('retains interrupted requests as progress, not as completed turns', async () => {
    const context = await load(async () => page([
      record('u1', 'user', 'Implement both fixes'),
      record('a1', 'assistant', 'First fix done', { finish: 'tool-calls', parentID: 'u1' }),
      ...pair(2),
    ]));
    expect(context.turns[0].complete).toBe(false);
    expect(context.turns[0].assistant.text).toBe('First fix done');
    expect(context.turns[1].complete).toBe(true);
  });

  it('keeps synthetic annotations and separates author language from quoted material', async () => {
    const user = record('u', 'user', '', {}, [{
      type: 'text', synthetic: true, text: 'Serialized attachment',
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'English quoted source', text: 'Виправ саме це' } },
    }]);
    const context = await load(async () => page([user, record('a', 'assistant', 'Done', { parentID: 'u' })]));
    expect(context.turns[0].user.text).toContain('> English quoted source');
    expect(context.turns[0].user.text).toContain('User comment:\nВиправ саме це');
    expect(context.turns[0].user.authored).toBe('Виправ саме це');
  });

  it('retains the comment after a large quote and the conclusion after a long answer', async () => {
    const user = record('u', 'user', '', {}, [{ type: 'text', synthetic: true, text: 'attachment', metadata: {
      openchamberContext: { kind: 'browser-annotation', prompt: 'x'.repeat(30_000), text: 'USER_REQUEST_END' },
    } }]);
    const context = await load(async () => page([user, record('a', 'assistant', `START${'x'.repeat(30_000)}CONCLUSION`, { parentID: 'u' })]));
    expect(context.turns[0].user.text).toContain('USER_REQUEST_END');
    expect(context.last.text).toMatch(/^START/);
    expect(context.last.text).toMatch(/CONCLUSION$/);
    expect(context.last.text.length).toBeLessThanOrEqual(16_000);
  });

  it('fails explicitly on malformed annotation text instead of losing the comment', async () => {
    const user = record('u', 'user', '', {}, [{ type: 'text', synthetic: true, text: 'attachment', metadata: {
      openchamberContext: { kind: 'chat-quote', quote: 'source', text: 42 },
    } }]);
    await expect(load(async () => page([user, record('a', 'assistant', 'done')]))).rejects.toThrow();
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
    const context = await load(async () => page([record(`a${++calls}`, 'assistant', 'answer')], `cursor${calls}`));
    expect(calls).toBe(8);
    expect(context).toBeNull();
  });

  it('skips unfinished, failed, summary, and user tails', async () => {
    for (const tail of [
      record('tail', 'user', 'New request'),
      record('tail', 'assistant', 'Working', { finish: 'tool-calls' }),
      record('tail', 'assistant', 'Failed', { error: { name: 'error' } }),
      record('tail', 'assistant', 'Summary', { summary: true }),
    ]) expect(await load(async () => page([...pair(1), tail]))).toBeNull();
  });

  it('keeps both sides of the newest exchange within a small model budget', async () => {
    const context = await load(async () => page([
      ...pair(1), ...pair(2), record('latest', 'user', `REQUEST_START${'u'.repeat(8000)}REQUEST_END`),
      record('answer', 'assistant', `ANSWER_START${'a'.repeat(16000)}ANSWER_END`, { parentID: 'latest' }),
    ]));
    for (const budget of [1_000, 4_000, 14_000, 32_000, 1_000_000]) {
      const prompt = buildAssistPrompt(context.turns, { recap: true, suggestion: true }, budget);
      expect(prompt.text.length).toBeLessThanOrEqual(Math.min(budget, 32_000));
      for (const marker of ['REQUEST_START', 'REQUEST_END', 'ANSWER_START', 'ANSWER_END']) expect(prompt.text).toContain(marker);
    }
    expect(buildAssistPrompt(context.turns, { recap: true }, 500)).toBeNull();
    expect(excerpt('long text', 0)).toBe('');
    expect(excerpt('long text', 2)).toBe('lo');
    for (let limit = 0; limit < 60; limit++) expect(excerpt('x'.repeat(100), limit).length).toBeLessThanOrEqual(limit);
  });

  it('does not assign an older parent\'s late answer to a newer user request', async () => {
    expect(await load(async () => page([
      ...pair(1), record('new-user', 'user', 'A different request'),
      record('late-answer', 'assistant', 'Old work done', { parentID: 'u1' }),
    ]))).toBeNull();
  });
});
