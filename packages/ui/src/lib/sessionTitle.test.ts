import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Part, Session, TextPart } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { collectSessionTitleTurns, formatSessionTitleContext, generatedSessionTitleSchema, generateSessionTitle } from './sessionTitle';
import { configureRuntimeUrlResolver } from './runtime-url';
import { createContextPart, type ContextPartPayload } from './messages/contextParts';
import { formatMessageText } from './messages/messageMarkdown';
import { formatSessionAsMarkdown } from './exportSession';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { loadSessionTitleTurns } from '@/sync/session-title-context';
import { cancelSessionTitleGeneration, generateAndSaveSessionTitle, runSessionTitleGeneration } from '@/sync/session-title-generation';
import { getRuntimeKey } from './runtime-switch';

type RecordEntry = { info: Message; parts: Part[] };
const textPart = (text: string, synthetic = false): TextPart => ({
  id: 'part', messageID: 'message', sessionID: 'session', type: 'text', text, synthetic,
});
function user(id: string, parts: Part[] = [textPart(`Request ${id}`)]): RecordEntry {
  return {
    info: { id, sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'provider', modelID: 'model' } },
    parts,
  };
}
function assistant(parentID: string, options: Partial<AssistantMessage> = {}, parts: Part[] = [textPart(`Answer ${parentID}`)]): RecordEntry {
  return {
    info: {
      id: `answer-${parentID}`, parentID, sessionID: 'session', role: 'assistant',
      time: { created: 2, completed: 3 }, finish: 'stop', providerID: 'provider', modelID: 'model', agent: 'build', mode: 'build',
      path: { cwd: '/project', root: '/project' }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...options,
    }, parts,
  };
}
const contextPart = (payload: ContextPartPayload): TextPart => ({
  ...textPart(''), ...createContextPart(payload),
});
const pair = (id: string) => [user(id), assistant(id)];
const session: Session = {
  id: 'session', title: 'Original', slug: 'original', projectID: 'project', directory: '/project', version: '1',
  time: { created: 1, updated: 2 },
};

describe('session title context', () => {
  test('selects the latest three completed pairs, ignoring intermediate and unfinished steps', () => {
    const records = [
      ...pair('old'), ...pair('one'), user('two'),
      assistant('two', { finish: 'tool-calls' }, [textPart('Progress noise')]), assistant('two'),
      ...pair('three'), user('running'), assistant('running', { time: { created: 4 } }),
    ];
    const turns = collectSessionTitleTurns(records);
    expect(turns.map((turn) => turn.user.info.id)).toEqual(['one', 'two', 'three']);
    const context = formatSessionTitleContext(turns);
    expect(context).not.toContain('Progress noise');
    expect(context).not.toContain('Request old');
    expect(context).not.toContain('Request running');
    expect(context.indexOf('Request one')).toBeLessThan(context.indexOf('Answer one'));
    expect(context.indexOf('Answer one')).toBeLessThan(context.indexOf('Request two'));
  });

  test('does not promote a prior final when a newer response to the same user is unfinished', () => {
    expect(collectSessionTitleTurns([...pair('one'), assistant('one', { id: 'later', finish: 'tool-calls' })])).toEqual([]);
  });

  test('excludes summaries, failed turns, synthetic nudges and reverted history', () => {
    const records = [
      ...pair('real'), user('summary'), assistant('summary', { summary: true }),
      user('error'), assistant('error', { error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }),
      user('nudge', [textPart('Agent completed', true)]), assistant('nudge'), ...pair('reverted'),
    ];
    expect(collectSessionTitleTurns(records, 'reverted').map((turn) => turn.user.info.id)).toEqual(['real']);
    expect(collectSessionTitleTurns(records, 'not-loaded')).toEqual([]);
    expect(collectSessionTitleTurns([])).toEqual([]);
  });

  test('retains annotation-only user messages and excludes unrelated injected instructions', () => {
    const records = [user('quote', [contextPart({ kind: 'chat-quote', quote: 'Earlier answer', text: 'Fix this detail' }), textPart('Secret system instruction', true)]), assistant('quote')];
    const context = formatSessionTitleContext(collectSessionTitleTurns(records));
    expect(context).toContain('> Earlier answer');
    expect(context).toContain('**User comment:**\n\nFix this detail');
    expect(context).not.toContain('Secret system instruction');
  });

  test('bounds oversized turns without losing replies after large quoted sources', () => {
    const turns = collectSessionTitleTurns(['one', 'two', 'three'].flatMap((id) => [
      user(id, [contextPart({ kind: 'code-comment', source: 'file', fileLabel: 'big.ts', startLine: 1, endLine: 10000, language: 'ts', code: 'x'.repeat(100000), text: `Fix ${id}` })]),
      assistant(id, {}, [textPart('y'.repeat(100000))]),
    ]));
    const context = formatSessionTitleContext(turns);
    expect(context.length).toBeLessThan(24500);
    expect(context).toContain('[Content omitted]');
    for (const id of ['one', 'two', 'three']) expect(context).toContain(`Fix ${id}`);
  });

  test('matches OpenCode cleanup by removing thinking and taking the first nonempty line', () => {
    expect(generatedSessionTitleSchema.parse({ text: ' \n<think>Reasoning\ncontinued</think>\n<think>More reasoning</think>\n Нова назва \nExplanation' })).toBe('Нова назва');
    expect(generatedSessionTitleSchema.parse({ text: 'Title\nExplanation' })).toBe('Title');
    expect(generatedSessionTitleSchema.parse({ text: ' "Нова назва" ' })).toBe('"Нова назва"');
    for (const payload of [{ text: '' }, { text: '  \n ' }, { text: '<think>Only reasoning</think>' }, { text: 5 }, {}]) {
      expect(() => generatedSessionTitleSchema.parse(payload)).toThrow();
    }
  });

  test('preserves titles up to 100 characters and truncates longer ones to 97 plus ellipsis', () => {
    for (const length of [50, 70, 100]) {
      const text = 'н'.repeat(length);
      expect(generatedSessionTitleSchema.parse({ text })).toBe(text);
    }
    expect(generatedSessionTitleSchema.parse({ text: 'н'.repeat(101) })).toBe('н'.repeat(97) + '...');
  });
});

describe('Markdown export of attached context', () => {
  test('exports quote and reply exactly once with paragraph separation, including child sessions', () => {
    const record = user('one', [textPart('My request'), contextPart({ kind: 'file-quote', fileLabel: 'plan.md', startLine: 2, endLine: 4, quote: 'First line\n\nLast line', text: 'My comment' })]);
    const output = formatSessionAsMarkdown([record], 'Title', [{ title: 'Child', records: [record], children: [] }]);
    expect(output).toContain('My request\n\nQuoted from `plan.md`, lines 2-4:');
    expect(output).toContain('> First line\n> \n> Last line\n\n**User comment:**\n\nMy comment');
    expect(output.match(/My comment/g)).toHaveLength(2);
    expect(output).not.toContain('Comment on this fragment');
  });

  test('formats browser, PR, code and terminal contexts without mixing comments into quotes', () => {
    const contexts: ContextPartPayload[] = [
      { kind: 'browser-annotation', pageUrl: 'https://example.com', prompt: 'Button', text: 'Move it' },
      { kind: 'pr-comment', label: '#7 review', body: 'Reviewer comment', text: 'Agreed' },
      { kind: 'pr-check', label: 'CI', output: 'Build failed', text: 'Fix build' },
      { kind: 'code-comment', source: 'diff', fileLabel: 'app.ts', startLine: 1, endLine: 2, side: 'modified', language: 'ts', code: 'const x = 1;', text: 'Change x' },
      { kind: 'terminal', terminalId: 'term', terminalLabel: 'Shell', startLine: 1, endLine: 1, output: 'Log output' },
    ];
    const output = formatMessageText(contexts.map(contextPart), { user: true });
    for (const content of ['Button', 'Reviewer comment', 'Build failed', 'const x = 1;', 'Log output']) expect(output).toContain(`> ${content}`);
    for (const comment of ['Move it', 'Agreed', 'Fix build', 'Change x']) expect(output).toContain(`**User comment:**\n\n${comment}`);
    expect(output).not.toContain('<terminal_context>');
    expect(output).toContain('> ```ts\n> const x = 1;\n> ```');
  });

  test('preserves legacy terminal context and malformed metadata as readable text', () => {
    const output = formatMessageText([
      textPart('Check this\n\n<terminal_context>\n- Shell lines 1-1:\n  1 | failure\n</terminal_context>'),
      { ...textPart('Legacy comment'), metadata: { openchamberContext: { kind: 'broken' } } },
    ], { user: true });
    expect(output).toContain('> failure');
    expect(output).toContain('Check this');
    expect(output).toContain('Legacy comment');
  });
});

describe('bounded history loading', () => {
  test('uses the real shared loader and stops paging as soon as three pairs are available', async () => {
    let requests = 0;
    const childStores = new ChildStoreManager();
    const sdk = createOpencodeClient({ baseUrl: 'http://session-title.test', fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify(requests === 1 ? pair('three') : [...pair('one'), ...pair('two')]), {
        headers: { 'Content-Type': 'application/json', 'x-next-cursor': requests === 1 ? 'older' : 'much-older' },
      });
    } });
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: 'test' });
    const target = { sessionID: 'session', directory: '/project' };
    try {
      const turns = await loadSessionTitleTurns({
        loader, target, signal: new AbortController().signal,
        getRecords: () => {
          const state = childStores.getChild('/project')?.getState();
          return (state?.message.session ?? []).map((info) => ({ info, parts: state?.part[info.id] ?? [] }));
        },
      });
      expect(turns).toHaveLength(3);
      expect(requests).toBe(2);
      expect(loader.getSnapshot(target).complete).toBe(false);
    } finally { loader.dispose(); childStores.disposeAll(); }
  });

  test('does not use cached partial turns when the authoritative loader failed', async () => {
    const error = new Error('offline');
    const loader = {
      ensure: async () => {}, loadOlder: async () => {},
      getSnapshot: (): ReturnType<SessionMessageLoader['getSnapshot']> => ({ status: 'error', loadingKind: null, error, resolved: true, limit: 50, cursor: 'older', complete: false, generation: 0, updatedAt: 1 }),
    };
    await expect(loadSessionTitleTurns({ loader, target: { sessionID: 'session', directory: '/project' }, getRecords: () => pair('cached'), signal: new AbortController().signal })).rejects.toThrow('offline');
  });

  test('an explicit retry refreshes a failed loader even when older messages remain cached', async () => {
    let state: ReturnType<SessionMessageLoader['getSnapshot']> = {
      status: 'error', loadingKind: null, error: new Error('offline'), resolved: true,
      limit: 50, cursor: undefined, complete: true, generation: 0, updatedAt: 1,
    };
    const loader = {
      ensure: async (_target: { directory: string; sessionID: string }, options?: { force?: boolean }) => {
        expect(options?.force).toBe(true);
        state = { ...state, status: 'ready', error: null, generation: 1 };
      },
      loadOlder: async () => {},
      getSnapshot: () => state,
    };
    const turns = await loadSessionTitleTurns({ loader, target: { sessionID: 'session', directory: '/project' }, getRecords: () => pair('recovered'), signal: new AbortController().signal });
    expect(turns).toHaveLength(1);
  });
});

describe('generation lifecycle', () => {
  const turns = collectSessionTitleTurns(pair('one'));
  test('calls the existing Small Model route with the target session and provider', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/api/small-model/generate');
      expect(request.method).toBe('POST');
      expect(await request.json()).toMatchObject({
        sessionID: 'session', directory: '/project', preferredProviderID: 'provider', preferredModelID: 'model', restrictToPreferredProvider: true,
      });
      calls += 1;
      return calls === 1 ? Response.json({ text: 'A useful title' }) : new Response('Unavailable', { status: 503 });
    };
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://session-title.test' });
    try {
      const input = { turns, sessionID: 'session', directory: '/project', signal: new AbortController().signal };
      expect(await generateSessionTitle(input)).toBe('A useful title');
      await expect(generateSessionTitle(input)).rejects.toThrow('Session title generation failed');
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; configureRuntimeUrlResolver({ apiBaseUrl: '' }); }
  });

  test('saves only after generation and a fresh metadata read', async () => {
    const events: string[] = [];
    await generateAndSaveSessionTitle({
      signal: new AbortController().signal,
      prepare: async () => ({ session, turns }),
      generate: async () => { events.push('generate'); return 'New title'; },
      readSession: async () => { events.push('read'); return session; },
      saveTitle: async (title) => { events.push(title); },
    });
    expect(events).toEqual(['generate', 'read', 'New title']);
  });

  test('preserves newer manual titles, moves, archives and reverts', async () => {
    const mutations: Session[] = [
      { ...session, title: 'Manual' }, { ...session, directory: '/moved' },
      { ...session, time: { ...session.time, archived: 10 } }, { ...session, revert: { messageID: 'reverted' } },
    ];
    for (const current of mutations) {
      let saved = false;
      await generateAndSaveSessionTitle({
        signal: new AbortController().signal, prepare: async () => ({ session, turns }),
        generate: async () => 'AI title', readSession: async () => current, saveTitle: async () => { saved = true; },
      });
      expect(saved).toBe(false);
    }
  });

  test('generation failure and cancellation never save a title', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let saved = false;
      await expect(generateAndSaveSessionTitle({
        signal: controller.signal, prepare: async () => ({ session, turns }),
        generate: async () => { if (cancel) { controller.abort(); return 'AI title'; } throw new Error('model offline'); },
        readSession: async () => session, saveTitle: async () => { saved = true; },
      })).rejects.toThrow();
      expect(saved).toBe(false);
    }
  });

  test('deduplicates across menus, cancels on a manual save, and permits retry after cleanup', async () => {
    const target = { runtimeKey: getRuntimeKey(), directory: '/project', sessionID: 'session' };
    let finish = () => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    let saved = false;
    const first = runSessionTitleGeneration(target, async (signal) => {
      calls += 1;
      await gate;
      signal.throwIfAborted();
      saved = true;
    });
    await runSessionTitleGeneration(target, async () => { calls += 1; });
    expect(calls).toBe(1);
    cancelSessionTitleGeneration(target.sessionID);
    finish();
    await first;
    expect(saved).toBe(false);
    await runSessionTitleGeneration(target, async () => { calls += 1; });
    expect(calls).toBe(2);
  });

  test('failed operations release pending state and unrelated directories can run independently', async () => {
    const target = { runtimeKey: getRuntimeKey(), directory: '/project', sessionID: 'session' };
    await expect(runSessionTitleGeneration(target, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    let calls = 0;
    await runSessionTitleGeneration(target, async () => {
      await runSessionTitleGeneration({ ...target, directory: '/other' }, async () => { calls += 1; });
      calls += 1;
    });
    expect(calls).toBe(2);
  });

  test('a runtime switch cancels the operation even when the same runtime key returns', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const events = new EventTarget();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
    try {
      const target = { runtimeKey: getRuntimeKey(), directory: '/project', sessionID: 'session' };
      let saved = false;
      await runSessionTitleGeneration(target, async (signal) => {
        events.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
        // Returning to the same key cannot make an aborted operation current.
        expect(getRuntimeKey()).toBe(target.runtimeKey);
        signal.throwIfAborted();
        saved = true;
      });
      expect(saved).toBe(false);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
