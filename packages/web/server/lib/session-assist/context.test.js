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

  it('reads a linked item as context, never as the user\'s own words, for the current link kinds and the legacy ones', async () => {
    for (const kind of ['repository-issue', 'change-request', 'tracker-item', 'github-issue', 'linear-issue']) {
      const link = user('u', `Linked ${kind}: ENG-12 Search`, { metadata: { openchamberContext: { kind } } });
      const context = await load(async () => page([link, assistant('a', 'Done')]));
      expect(context.turns[0].user.text, kind).toContain(`Linked ${kind}: ENG-12 Search`);
      // The authored text is the language sample; a linked item's title is not one.
      expect(context.turns[0].user.authored, kind).not.toContain('ENG-12');
    }
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

  it.each(['quote', 'text', 'fileLabel', 'label', 'pageUrl', 'terminalLabel'])('fails explicitly on malformed attachment %s', async (field) => {
    const attachment = synthetic('s', 'attachment', {
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'source', [field]: 42 } },
    });
    await expect(load(async () => page([attachment, user('u', 'Fix'), assistant('a', 'done')]))).rejects.toThrow();
  });

  it.each(['comment', 'preview', 'path'])('fails explicitly on malformed OpenCode comment %s', async (field) => {
    const attachment = synthetic('s', 'attachment', {
      metadata: { opencodeComment: { comment: 'Fix this', [field]: 42 } },
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

  describe('record of what ran', () => {
    const tool = (name, input, metadata = {}, status = 'completed') => ({
      type: 'tool', id: 'call', name, state: { status, input, metadata, content: [{ type: 'text', text: 'TOOL_OUTPUT' }], error: { type: 'x', message: 'TOOL_ERROR' } },
    });
    const step = (id, ...parts) => assistant(id, '', { finish: 'tool-calls', content: parts });
    const FALLBACK = 'The final synthesis could not be generated. Consult the tool results.';
    const promptFor = async (records, budget = 32_000) => {
      const context = await load(async () => page(records));
      return buildAssistPrompt(context.turns, { recap: true, suggestion: true }, budget).text;
    };

    it('carries the work of a turn whose answer reports none, without outputs, contents or credentials', async () => {
      const prompt = await promptFor([
        user('u', 'Build the page'),
        step('s1',
          tool('write', { path: '/repo/index.html', content: 'FILE_BODY' }),
          tool('edit', { path: '/repo/src/app.js', oldString: 'OLD_BODY', newString: 'NEW_BODY' }, { files: [{ file: 'src/app.js', patch: 'PATCH_BODY', status: 'modified' }] }),
          tool('patch', {}, { files: [{ file: 'src/gone.js', patch: 'PATCH_BODY', status: 'deleted' }] }),
          tool('write', { path: '/repo/refused.txt', content: 'FILE_BODY' }, {}, 'error')),
        step('s2',
          tool('shell', { command: "cat > note.py <<'EOF'\nprint('FILE_BODY')\nEOF\npython3 note.py" }, { status: 'completed', exit: 0 }),
          tool('shell', { command: 'API_KEY=SECRET_A curl -H "Authorization: Bearer SECRET_B" https://u:SECRET_C@host/ && git commit -m "SECRET_D; x"' }, { status: 'completed', exit: 0 }),
          tool('shell', { command: 'mysql -pSECRET_E; login --password SECRET_F' }, { status: 'completed', exit: 0 }),
          tool('execute', { code: 'CODE_BODY' }, { toolCalls: [{ tool: 'linear.save_issue', status: 'completed', input: { title: 'INPUT_BODY' } }, { tool: 'fetch', status: 'error' }] })),
        assistant('a', FALLBACK),
      ]);
      for (const shown of ['index.html', 'app.js', 'gone.js (deleted)', 'write x1 (1 failed)', 'cat > note.py, python3 note.py (last step ok)', 'git commit', 'linear.save_issue x1', 'fetch x1 (1 failed)']) expect(prompt).toContain(shown);
      expect(prompt).not.toMatch(/TOOL_OUTPUT|TOOL_ERROR|_BODY|SECRET_/);
    });

    it.each([
      "redis-cli AUTH SECRET_G; cat > conf <<'END-CONFIG'\nsecret_body\nEND-CONFIG\nvault login s.SECRET_H",
      "cat <<'A'\nx\nA\ncat <<'B'\nA\nleaked words\nB",
      "cat <<'A'\r\nA\nleaked words\nA\r",
      'cat <<A <<B\nFILE_BODY\nA\nFILE_BODY\nB',
      "cat <<'EOF_PART'_MORE\nEOF_PART\nleaked words\nEOF_PART_MORE",
      'cat <<A <<-B\nleaked one\nB\nleaked two\nA\nleaked three\nB',
      "# don't <<-X\ncat <<EOF\nEOF\r\nleaked words\nEOF\necho 'leaked more'",
      "echo it\\'s; tool 'leaked a' # leaked b; leaked c",
      'cat <\\\n<EOF\nleaked words\nEOF',
      'echo "$(printf "\nleaked words\n")"',
      'cat <<EOF\n  EOF\nleaked words\nEOF',
      'curl https://host/$(cat SECRET_I) \'SECRET_J',
      'printf \'a\' \\\\\\\n; printf "leaked words\\nleaked more"',
    ])('drops arguments and bodies it cannot read safely: %j', async (command) => {
      const prompt = await promptFor([user('u', 'Go'), step('s', tool('shell', { command }, { exit: 0 })), assistant('a', FALLBACK)]);
      expect(prompt).toContain('Ran, newest first: ');
      expect(prompt).not.toMatch(/_BODY|SECRET_|secret_body|leaked/);
    });

    it('reports how each command and background job ended', async () => {
      const shell = (command, metadata, status) => tool('shell', { command }, metadata, status);
      const prompt = await promptFor([
        user('u', 'Run them'),
        step('s1',
          shell('bun test', { status: 'completed', exit: 1 }),
          shell('bun lint', { status: 'completed', exit: 2 }),
          shell('bun build', {}, 'error')),
        step('s1b', shell('bun check | tail', { status: 'completed', exit: 0 }), shell('cd /repo && make it', { exit: 0 })),
        step('s2',
          shell('bun lint', { status: 'completed', exit: 0 }),
          shell('make long', { status: 'completed', timeout: true }),
          shell('make bg', { status: 'running', shellID: 'sh_1' })),
        step('s3',
          shell('make dev', { status: 'running', shellID: 'sh_2' }),
          tool('subagent', { description: 'Write notes', prompt: 'x' }, { sessionID: 'ses_child', status: 'running' })),
        synthetic('r1', 'RESULT', { metadata: { source: 'shell', shellID: 'sh_1', state: 'completed', exit: 7 } }),
        synthetic('r2', 'RESULT', { metadata: { source: 'subagent', childID: 'ses_child', state: 'completed' } }),
        assistant('a', FALLBACK),
      ]);
      for (const shown of ['make dev (started in background)', 'subagent "Write notes" (finished)', 'make bg (failed, exit 7)', 'make long (stopped)', 'bun lint (ok)', 'make it (ok)', 'check, tail (last step ok)']) expect(prompt).toContain(shown);
      expect(prompt).not.toContain('RESULT');
    });

    it('never turns an unchecked, failed or earlier result into another one', async () => {
      const agent = (status) => tool('subagent', { description: 'Round' }, { sessionID: 'ses_c', status });
      const notice = (id, state) => synthetic(id, 'RESULT', { metadata: { source: 'subagent', childID: 'ses_c', state } });
      const prompt = await promptFor([
        user('u', 'Go'),
        step('s1', agent('running')), notice('n1', 'completed'),
        step('s2', agent('running'), tool('shell', { command: 'cat | bun test | cat' }, { exit: 0 })), notice('n2', 'error'),
        assistant('m', FALLBACK), user('u2', 'More'),
        step('s3',
          tool('shell', { command: 'false &' }, { exit: 0 }),
          tool('execute', {}, { error: true, toolCalls: [{ tool: 'write', status: 'completed' }, { tool: 'fetch', status: 'running' }], files: [{ file: 'kept.txt', status: 'added' }] }),
          tool('execute', {}, { jobID: 'cm_1' }),
          tool('generate_image', {}, { jobID: 'im_1' }),
          tool('shell', { command: 'cd gone && bun test' }, { exit: 1 }),
          tool('shell', { command: 'bun lint || true' }, { exit: 0 })),
        step('s4', agent('running')), notice('n4', 'cancelled'),
        synthetic('n5', 'RESULT', { metadata: { source: 'generate_image', jobID: 'im_1', state: 'completed' } }),
        synthetic('n3', 'RESULT', { metadata: { source: 'codemode', jobID: 'cm_1', state: 'error' } }),
        assistant('a', FALLBACK),
      ]);
      for (const shown of ['"Round" (finished)', '"Round" (failed)', 'false (result unknown)', 'execute job (failed)', 'generate_image job (finished)', 'bun test (a step failed, exit 1)', 'bun lint (result unknown)', 'cat, bun test (result unknown)', '"Round" (stopped)', 'execute x1 (1 failed)', 'fetch (unfinished) x1', 'kept.txt']) expect(prompt).toContain(shown);
    });

    it('keeps a background report out of the next user message', async () => {
      const context = await load(async () => page([
        ...pair(1), synthetic('n', 'REPORT', { metadata: { source: 'subagent', childID: 'c', state: 'completed' } }), ...pair(2),
      ]));
      expect(context.turns.at(-1).user.text).toBe('request 2');
    });

    it('says when nothing ran', async () => {
      expect(await promptFor(pair(1))).toContain('from the session record:\nnone');
    });

    it('never cuts through a step in a small budget', async () => {
      const ran = ['build', 'lint', 'check', 'smoke', 'types', 'bench'].map((name, i) => tool('shell', { command: `bun run ${name}` }, { exit: i % 2 }));
      const long = ['x', 'y', 'z'].flatMap((name) => [tool('write', { path: `/repo/${name.repeat(100)}.ts` }), tool(name.repeat(100), {}, {}, 'error')]);
      const turn = (...parts) => [user('u', 'Go'), step('s', ...parts), assistant('a', 'x'.repeat(4_000))];
      const commandsIn = (prompt) => prompt.match(/Ran, newest first: (.*)/)[1].split('; ');
      const whole = commandsIn(await promptFor(turn(...ran)));
      expect(whole.length).toBe(6);

      let previous = 0;
      for (let budget = 1_000; budget <= 2_500; budget += 50) {
        const commands = commandsIn(await promptFor(turn(...ran, ...long), budget));
        const named = commands.filter((entry) => !entry.startsWith('+'));
        expect(named).toEqual(whole.slice(0, named.length));
        expect(commands.length > named.length).toBe(named.length < 6);
        expect(named.length).toBeGreaterThanOrEqual(previous);
        previous = named.length;
      }
      expect(commandsIn(await promptFor(turn(...ran), 1_500))).toEqual(whole);
    });

    it('adds a bounded amount per turn however much ran, and fits a small budget', async () => {
      const many = Array.from({ length: 300 }, (_, i) => [
        tool('write', { path: `/repo/${'f'.repeat(300)}${i}.ts` }),
        tool('shell', { command: `program${i} ${'w'.repeat(300)} && next${i}` }, { exit: 0 }),
        tool(`server_${i}_${'t'.repeat(300)}`, {}),
      ]).flat();
      const records = [user('u', 'Go'), step('s', ...many), assistant('a', FALLBACK)];
      const bare = await promptFor([user('u', 'Go'), assistant('a', FALLBACK)]);
      expect((await promptFor(records)).length - bare.length).toBeLessThan(550);
      for (const budget of [1_000, 1_500]) {
        const text = await promptFor(records, budget);
        expect(text.length).toBeLessThanOrEqual(budget);
        expect(text).toContain('Go');
      }
    });
  });

  it('excerpts from both ends so the start and the end both survive', () => {
    expect(excerpt('abcdef', 10)).toBe('abcdef');
    const trimmed = excerpt(`START${'x'.repeat(500)}END`, 100);
    expect(trimmed.length).toBeLessThanOrEqual(100);
    expect(trimmed).toMatch(/^START/);
    expect(trimmed).toMatch(/END$/);
  });
});
