import { describe, expect, test } from 'bun:test';
import { type JsonValue } from '@opencode-ai/client';
import type { GlobalEvent, OpencodeClient } from '@opencode-ai/sdk/v2';
import { createOpencode2Adapter, resolveOpenCodeProtocol, type OpenCodeProtocol, type OpenCodeRuntimeFetch } from './opencode2-adapter';

type V2SessionFixture = {
  id: string;
  parentID?: string;
  projectID: string;
  agent: string;
  model: { id: string; providerID: string };
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; updated: number };
  title: string;
  location: { directory: string };
};

type PromptAsyncCall = (input: {
  sessionID: string;
  messageID: string;
  delivery: 'steer';
  format?: { type: string };
  parts: Array<{ type: 'text'; text: string }>;
}, options: { signal: AbortSignal; headers: HeadersInit }) => Promise<{ data?: boolean; error?: Error }>;

const json = (value: JsonValue, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

const v2Session = (id: string, parentID?: string): V2SessionFixture => {
  const session: V2SessionFixture = {
    id,
    projectID: 'project-1',
    agent: 'build',
    model: { id: 'model-1', providerID: 'provider-1' },
    cost: 1.25,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    time: { created: 10, updated: 20 },
    title: `Title ${id}`,
    location: { directory: '/repo' },
  };
  if (parentID) session.parentID = parentID;
  return session;
};

const legacyStub = (): OpencodeClient => Object.assign(Object.create(null), {
  session: {
    list: async () => ({ data: [] }),
    get: async () => ({ data: undefined }),
    create: async () => ({ data: undefined }),
    delete: async () => ({ data: false }),
    update: async () => ({ data: undefined }),
    messages: async () => ({ data: [] }),
    promptAsync: async () => ({ data: true }),
    command: async () => ({ data: undefined }),
    shell: async () => ({ data: undefined }),
    revert: async () => ({ data: undefined }),
    summarize: async () => ({ data: false }),
    unrevert: async () => ({ data: undefined }),
    fork: async () => ({ data: undefined }),
    abort: async () => ({ data: true }),
    status: async () => ({ data: {} }),
    todo: async () => ({ data: [] }),
  },
  experimental: { session: { list: async () => ({ data: [] }) }, controlPlane: { moveSession: async () => ({ data: undefined }) } },
  path: { get: async () => ({ data: undefined }) },
  project: { list: async () => ({ data: [] }), current: async () => ({ data: undefined }) },
  permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
  question: { list: async () => ({ data: [] }), reply: async () => ({ data: true }), reject: async () => ({ data: true }) },
  command: { list: async () => ({ data: [] }) },
  mcp: { status: async () => ({ data: {} }) },
  vcs: { get: async () => ({ data: {} }) },
  global: { event: async () => ({ stream: (async function* () {})() }) },
  config: { get: async () => ({ data: {} }), update: async () => ({ data: {} }), providers: async () => ({ data: { providers: [], default: {} } }) },
  app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
  file: { read: async () => ({ data: '' }), list: async () => ({ data: [] }) },
  tool: { ids: async () => ({ data: [] }) },
  lsp: { status: async () => ({ data: [] }) },
});

const adapter = (
  fetch: OpenCodeRuntimeFetch,
  protocol: OpenCodeProtocol = 'opencode2',
  legacy = legacyStub(),
): OpencodeClient => createOpencode2Adapter(legacy, 'https://openchamber.test', '/repo', fetch, async () => protocol);

describe('OpenCode V2 adapter', () => {
  test('resolves the current protocol without mutating the SDK shape', async () => {
    let protocol: OpenCodeProtocol = 'legacy';
    const client = createOpencode2Adapter(legacyStub(), 'https://openchamber.test', '/repo', async () => json({}), async () => protocol);

    expect(await resolveOpenCodeProtocol(client)).toBe('legacy');
    protocol = 'opencode2';
    expect(await resolveOpenCodeProtocol(client)).toBe('opencode2');
    expect(Object.hasOwn(client, 'protocol')).toBe(false);
  });

  test('delegates legacy calls exactly with original receiver and arguments', async () => {
    const input = { directory: '/legacy', limit: 7 };
    const options = { signal: new AbortController().signal };
    let receiverMatches = false;
    let received: unknown[] = [];
    const legacy = legacyStub();
    const session = legacy.session;
    Object.defineProperty(session, 'list', {
      configurable: true,
      value: async function (...args: unknown[]) {
        receiverMatches = this === session;
        received = args;
        return { data: [{ id: 'legacy' }] };
      },
    });

    const result = await adapter(async () => { throw new Error('V2 fetch should not run'); }, 'legacy', legacy).session.list(input, options);

    expect(receiverMatches).toBe(true);
    expect(received[0]).toBe(input);
    expect(received[1]).toBe(options);
    expect(result).toEqual({ data: [{ id: 'legacy' }] });
  });

  test('rewrites /api and preserves method, body, headers, and signal', async () => {
    const controller = new AbortController();
    let captured: Request | undefined;
    const client = adapter(async (input) => {
      captured = input instanceof Request ? input : new Request(input);
      return json({ id: 'inbox-1', sessionID: 'session-1', timeCreated: 1, type: 'user', payload: { text: 'hello' }, delivery: 'steer' });
    });

    // SAFETY: the adapter intentionally accepts the V2 compatibility input tested here.
    const send = client.session.promptAsync as PromptAsyncCall;
    const result = await send({
      sessionID: 'session-1',
      messageID: 'message-1',
      delivery: 'steer',
      parts: [{ type: 'text', text: 'hello' }],
    }, { signal: controller.signal, headers: { 'x-test': 'yes' } });

    expect(result.error).toBe(undefined);
    expect(captured?.url).toBe('https://openchamber.test/api/api/session/session-1/prompt');
    expect(captured?.method).toBe('POST');
    expect(captured?.headers.get('x-test')).toBe('yes');
    expect(captured?.signal).toBe(controller.signal);
    expect(await captured?.json()).toEqual({ id: 'message-1', text: 'hello', delivery: 'steer' });
  });

  test('rejects structured output before sending a V2 request', async () => {
    let requestCount = 0;
    const client = adapter(async () => {
      requestCount += 1;
      return json({});
    });
    // SAFETY: the adapter intentionally accepts the V2 compatibility input tested here.
    const send = client.session.promptAsync as PromptAsyncCall;

    const result = await send({
      sessionID: 'session-1',
      messageID: 'message-1',
      delivery: 'steer',
      format: { type: 'json_schema' },
      parts: [{ type: 'text', text: 'Return JSON' }],
    }, { signal: new AbortController().signal, headers: {} });

    expect(result.error?.message).toContain('does not support structured prompt output');
    expect(requestCount).toBe(0);
  });

  test('restores the session agent when switching the model fails', async () => {
    const agentSelections: string[] = [];
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === 'GET') return json({ data: v2Session('session-1') });
      if (request.url.endsWith('/agent')) {
        // SAFETY: the generated switch-agent request body is asserted by this focused transport fixture.
        agentSelections.push((await request.json() as { agent: string }).agent);
        return new Response(null, { status: 204 });
      }
      if (request.url.endsWith('/model')) throw new Error('model switch failed');
      return json({});
    });
    // SAFETY: the adapter intentionally accepts the V2 compatibility input tested here.
    const send = client.session.promptAsync as PromptAsyncCall;

    const result = await send({
      sessionID: 'session-1',
      messageID: 'message-1',
      delivery: 'steer',
      agent: 'review',
      model: { providerID: 'provider-2', modelID: 'model-2' },
      parts: [{ type: 'text', text: 'Review this' }],
    }, { signal: new AbortController().signal, headers: {} });

    expect(result.error).toBeDefined();
    expect(agentSelections).toEqual(['review', 'build']);
  });

  test('reports partial state and refreshes the session when agent rollback fails', async () => {
    const agentSelections: string[] = [];
    let sessionReads = 0;
    let promptSent = false;
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === 'GET') {
        sessionReads += 1;
        return json({ data: v2Session('session-1') });
      }
      if (request.url.endsWith('/agent')) {
        // SAFETY: the generated switch-agent request body is asserted by this focused transport fixture.
        const agent = (await request.json() as { agent: string }).agent;
        agentSelections.push(agent);
        if (agent === 'build') throw new Error('agent rollback failed');
        return new Response(null, { status: 204 });
      }
      if (request.url.endsWith('/model')) throw new Error('model switch failed');
      if (request.url.endsWith('/prompt')) promptSent = true;
      return json({});
    });
    // SAFETY: the adapter intentionally accepts the V2 compatibility input tested here.
    const send = client.session.promptAsync as PromptAsyncCall;

    const result = await send({
      sessionID: 'session-1',
      messageID: 'message-1',
      delivery: 'steer',
      agent: 'review',
      model: { providerID: 'provider-2', modelID: 'model-2' },
      parts: [{ type: 'text', text: 'Review this' }],
    }, { signal: new AbortController().signal, headers: {} });

    expect(result.error).toBeInstanceOf(AggregateError);
    if (!(result.error instanceof AggregateError)) throw new Error('Expected an AggregateError');
    expect(result.error.message).toContain('session state was refreshed');
    expect(result.error.errors).toHaveLength(2);
    expect(result.error.errors.every((error) => error instanceof Error)).toBe(true);
    expect(agentSelections).toEqual(['review', 'build']);
    expect(sessionReads).toBe(2);
    expect(promptSent).toBe(false);
  });

  test('normalizes sessions and traverses descendants with bounded parent pages', async () => {
    const parents: Array<string | null> = [];
    const client = adapter(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const parent = url.searchParams.get('parentID');
      parents.push(parent);
      if (parent === null || parent === '' || parent === 'null') return json({ data: [v2Session('root')], cursor: {} });
      if (parent === 'root') return json({ data: [v2Session('child', 'root')], cursor: {} });
      return json({ data: [], cursor: {} });
    });

    const result = await client.experimental.session.list({ directory: '/repo', roots: false, archived: false, limit: 100 });
    const exhausted = await client.experimental.session.list({ directory: '/repo', roots: false, archived: false, cursor: 9, limit: 100 });

    expect(parents).toEqual(['null', 'root', 'child']);
    expect(result.data?.map((session) => session.id)).toEqual(['root', 'child']);
    expect(result.data?.[0]?.slug).toBe('root');
    expect(result.data?.[0]?.version).toBe('2');
    expect(result.data?.[0]?.directory).toBe('/repo');
    expect(result.data?.[0]?.projectID).toBe('project-1');
    expect(result.data?.[0]?.agent).toBe('build');
    expect(result.data?.[0]?.cost).toBe(1.25);
    expect(exhausted.data).toEqual([]);
  });

  test('keeps archived=true inclusive and allows a fresh reload', async () => {
    let rootLoads = 0;
    const client = adapter(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const parent = url.searchParams.get('parentID');
      if (parent !== 'null') return json({ data: [], cursor: {} });
      rootLoads += 1;
      return json({
        data: [v2Session('active'), { ...v2Session('archived'), time: { created: 10, updated: 20, archived: 30 } }],
        cursor: {},
      });
    });

    const first = await client.experimental.session.list({ roots: true, archived: true });
    const second = await client.experimental.session.list({ roots: true, archived: true });

    expect(first.data?.map((session) => session.id)).toEqual(['active', 'archived']);
    expect(second.data?.map((session) => session.id)).toEqual(['active', 'archived']);
    expect(rootLoads).toBe(2);
  });

  test('normalizes user and assistant message text, reasoning, and tools', async () => {
    const client = adapter(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/message')) {
        return json({
          data: [
            { id: 'user-1', type: 'user', time: { created: 1 }, text: 'question' },
            {
              id: 'assistant-1', type: 'assistant', time: { created: 2, completed: 4 }, agent: 'build',
              model: { id: 'model-1', providerID: 'provider-1' },
              content: [
                { type: 'text', text: 'answer' },
                { type: 'reasoning', text: 'thinking', time: { created: 2, completed: 3 } },
                { type: 'tool', id: 'call-1', name: 'bash', state: { status: 'completed', input: { command: 'pwd' }, content: [{ type: 'text', text: '/repo' }], metadata: {} }, time: { created: 2, completed: 3 } },
              ],
              cost: 0.5,
              tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
            },
          ],
          cursor: { next: 'older-1' },
        });
      }
      return json({ data: v2Session('session-1') });
    });

    const result = await client.session.messages({ sessionID: 'session-1', limit: 20 });

    expect(result.error).toBe(undefined);
    expect(result.data?.[0].parts).toEqual([{ id: 'user-1:text:0', sessionID: 'session-1', messageID: 'user-1', type: 'text', text: 'question' }]);
    expect(result.data?.[1].parts).toEqual([
      { id: 'assistant-1:text:0', sessionID: 'session-1', messageID: 'assistant-1', type: 'text', text: 'answer' },
      { id: 'assistant-1:reasoning:1', sessionID: 'session-1', messageID: 'assistant-1', type: 'reasoning', text: 'thinking', time: { start: 2, end: 3 } },
      { id: 'call-1', sessionID: 'session-1', messageID: 'assistant-1', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/repo', title: 'bash', metadata: {}, time: { start: 2, end: 3 } } },
    ]);
    expect(result.response?.headers.get('x-next-cursor')).toBe('older-1');
  });

  test('returns an error instead of empty authority for unsupported endpoints', async () => {
    const result = await adapter(async () => json({})).session.status({ directory: '/repo' });
    expect(result.data).toBe(undefined);
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('no authoritative OpenCode V2 equivalent');
  });

  test('renames title-only updates and rejects mixed patches before mutation', async () => {
    const requests: Array<{ method: string; path: string; body?: object }> = [];
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const captured = { method: request.method, path: new URL(request.url).pathname };
      if (request.method === 'POST') requests.push({ ...captured, body: await request.json() });
      else requests.push(captured);
      if (request.method === 'POST') return new Response(null, { status: 204 });
      return json({ data: { ...v2Session('session-1'), title: 'Renamed' } });
    });

    const rejected = await client.session.update({ sessionID: 'session-1', title: 'Nope', metadata: { pinned: true } });
    const renamed = await client.session.update({ sessionID: 'session-1', title: 'Renamed' });

    expect(rejected.error).toBeInstanceOf(Error);
    expect(renamed.data?.title).toBe('Renamed');
    expect(requests).toEqual([
      { method: 'POST', path: '/api/api/session/session-1/rename', body: { title: 'Renamed' } },
      { method: 'GET', path: '/api/api/session/session-1' },
    ]);
  });

  test('maps commands, forks, and compatible manual compaction', async () => {
    const posts: Array<{ path: string; body: object }> = [];
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') return json({ data: v2Session('session-1') });
      const body = await request.json();
      posts.push({ path, body });
      if (path.endsWith('/fork')) return json({ data: v2Session('fork-1', 'session-1') });
      if (path.endsWith('/command')) return json({ data: { id: 'inbox-1', sessionID: 'session-1', timeCreated: 1, type: 'user', payload: { text: '' }, delivery: 'steer' } });
      return json({ data: { id: 'compact-1', sessionID: 'session-1', timeCreated: 1, type: 'compaction', payload: {}, delivery: 'steer' } });
    });

    const command = await client.session.command({ sessionID: 'session-1', messageID: 'message-1', command: 'review', arguments: '--quick', model: 'provider-1/model-1', variant: 'high', agent: 'build' });
    const fork = await client.session.fork({ sessionID: 'session-1', messageID: 'message-1' });
    const summarize = await client.session.summarize({ sessionID: 'session-1', providerID: 'provider-1', modelID: 'model-1' });

    expect(command.error).toBe(undefined);
    expect(fork.data?.id).toBe('fork-1');
    expect(summarize.data).toBe(true);
    expect(posts).toEqual([
      { path: '/api/api/session/session-1/command', body: { id: 'message-1', command: 'review', arguments: '--quick', agent: 'build', model: { id: 'model-1', providerID: 'provider-1', variant: 'high' } } },
      { path: '/api/api/session/session-1/fork', body: { boundary: { type: 'before', messageID: 'message-1' } } },
      { path: '/api/api/session/session-1/compact', body: {} },
    ]);
  });

  test('maps compatible direct session operations and rejects lossy variants', async () => {
    const requests: Array<{ method: string; path: string; body?: object }> = [];
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const captured = { method: request.method, path: new URL(request.url).pathname };
      if (request.method === 'POST') requests.push({ ...captured, body: await request.json().catch(() => undefined) });
      else requests.push(captured);
      if (request.method === 'GET') return json({ data: v2Session('session-1') });
      if (captured.path.endsWith('/revert/stage')) return json({ data: { messageID: 'message-1' } });
      return new Response(null, { status: 204 });
    });

    const move = await client.experimental.controlPlane.moveSession({ sessionID: 'session-1', destination: { directory: '/other' }, moveChanges: false });
    const rejectedMove = await client.experimental.controlPlane.moveSession({ sessionID: 'session-1', destination: { directory: '/other' }, moveChanges: true });
    const reverted = await client.session.revert({ sessionID: 'session-1', messageID: 'message-1' });
    const rejectedPart = await client.session.revert({ sessionID: 'session-1', messageID: 'message-1', partID: 'part-1' });
    const unreverted = await client.session.unrevert({ sessionID: 'session-1' });
    const shell = await client.session.shell({ sessionID: 'session-1', agent: 'build', model: { providerID: 'provider-1', modelID: 'model-1' }, command: 'pwd' });
    const archive = await client.session.update({ sessionID: 'session-1', time: { archived: 10 } });

    expect(move.error).toBe(undefined);
    expect(rejectedMove.error).toBeInstanceOf(Error);
    expect(reverted.data?.id).toBe('session-1');
    expect(rejectedPart.error).toBeInstanceOf(Error);
    expect(unreverted.data?.id).toBe('session-1');
    expect(shell.error).toBeInstanceOf(Error);
    expect(archive.error).toBeInstanceOf(Error);
    expect(requests).toEqual([
      { method: 'POST', path: '/api/api/session/session-1/move', body: { directory: '/other' } },
      { method: 'POST', path: '/api/api/session/session-1/revert/stage', body: { messageID: 'message-1', files: true } },
      { method: 'GET', path: '/api/api/session/session-1' },
      { method: 'POST', path: '/api/api/session/session-1/revert/clear', body: undefined },
      { method: 'GET', path: '/api/api/session/session-1' },
    ]);
  });

  test('rejects compaction with a different selected model before mutation', async () => {
    let posts = 0;
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === 'POST') posts += 1;
      return json({ data: v2Session('session-1') });
    });

    const result = await client.session.summarize({ sessionID: 'session-1', providerID: 'other', modelID: 'model-1' });

    expect(result.error).toBeInstanceOf(Error);
    expect(posts).toBe(0);
  });

  test('maps provider and model discovery into config.providers', async () => {
    const paths: string[] = [];
    const client = adapter(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      paths.push(path);
      if (path.endsWith('/provider')) return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'provider-1', name: 'Provider', activation: 'enabled', package: '@ai/provider', settings: { region: 'us' } }] });
      const model = { id: 'model-1', modelID: 'upstream-model', providerID: 'provider-1', name: 'Model', capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, variants: [{ id: 'high', settings: { effort: 'high' } }], time: { released: 0 }, cost: [{ input: 1, output: 2, cache: { read: 3, write: 4 } }], status: 'active', enabled: true, limit: { context: 100, output: 10 } };
      if (path.endsWith('/model/default')) return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: model });
      return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [model] });
    });

    const result = await client.config.providers({ directory: '/repo' });

    expect(paths.sort()).toEqual(['/api/api/model', '/api/api/model/default', '/api/api/provider']);
    expect(result.data?.default).toEqual({ 'provider-1': 'model-1' });
    const mappedModel = result.data?.providers[0]?.models['model-1'];
    expect(mappedModel?.id).toBe('model-1');
    expect(mappedModel?.providerID).toBe('provider-1');
    expect(mappedModel?.capabilities.attachment).toBe(true);
    expect(mappedModel?.capabilities.toolcall).toBe(true);
    expect(mappedModel?.cost).toEqual({ input: 1, output: 2, cache: { read: 3, write: 4 } });
    expect(mappedModel?.variants).toEqual({ high: { effort: 'high' } });
  });

  test('maps agents, file reads and lists, and skills', async () => {
    const client = adapter(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/agent')) return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [{ action: 'bash', resource: '*', effect: 'ask' }] }] });
      if (path.includes('/fs/read/')) return new Response('hello');
      if (path.endsWith('/fs/list')) return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ path: 'src', type: 'directory' }] });
      return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'skill-1', name: 'test', location: '/repo/SKILL.md', content: 'content' }] });
    });

    const agents = await client.app.agents({ directory: '/repo' });
    const file = await client.file.read({ directory: '/repo', path: 'README.md' });
    const files = await client.file.list({ directory: '/repo', path: '.' });
    const skills = await client.app.skills({ directory: '/repo' });

    expect(agents.data?.[0]?.name).toBe('build');
    expect(agents.data?.[0]?.mode).toBe('primary');
    expect(agents.data?.[0]?.permission).toEqual([{ permission: 'bash', pattern: '*', action: 'ask' }]);
    expect(file.data).toBe('hello');
    expect(files.data).toEqual([{ path: 'src', type: 'directory' }]);
    expect(skills.data).toEqual([{ id: 'skill-1', name: 'test', location: '/repo/SKILL.md', content: 'content' }]);
  });

  test('maps permissions and forms back to their owning sessions for replies', async () => {
    const posts: Array<{ path: string; body: object }> = [];
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (request.method === 'POST') {
        posts.push({ path: url.pathname, body: await request.json() });
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/permission/request')) {
        return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'permission-1', sessionID: 'session-1', action: 'bash', resources: ['*'], save: ['bash:*'], source: { type: 'tool', messageID: 'message-1', id: 'call-1' } }] });
      }
      return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'form-1', sessionID: 'session-1', title: 'Deploy', fields: [{ key: 'environment', type: 'string', title: 'Environment', options: [{ value: 'prod', label: 'Production' }] }, { key: 'confirm', type: 'boolean', title: 'Confirm' }] }] });
    });

    const permissions = await client.permission.list({ directory: '/repo' });
    const permissionReply = await client.permission.reply({ requestID: 'permission-1', reply: 'once' });
    const questions = await client.question.list({ directory: '/repo' });
    const questionReply = await client.question.reply({ requestID: 'form-1', answers: [['Production'], ['true']] });

    expect(permissions.data?.[0]).toEqual({ id: 'permission-1', sessionID: 'session-1', permission: 'bash', patterns: ['*'], metadata: {}, always: ['bash:*'], tool: { messageID: 'message-1', callID: 'call-1' } });
    expect(questions.data?.[0]?.id).toBe('form-1');
    expect(questions.data?.[0]?.sessionID).toBe('session-1');
    expect(questions.data?.[0]?.questions.map((question) => question.header)).toEqual(['Environment', 'Confirm']);
    expect(permissionReply.data).toBe(true);
    expect(questionReply.data).toBe(true);
    expect(posts).toEqual([
      { path: '/api/api/session/session-1/permission/permission-1/reply', body: { reply: 'once' } },
      { path: '/api/api/session/session-1/form/form-1/reply', body: { answer: { environment: 'prod', confirm: true } } },
    ]);
  });

  test('preserves generated form and permission not-found errors in the legacy envelope', async () => {
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.includes('/form/')) {
        return json({ _tag: 'FormNotFoundError', id: 'form-1', message: 'Form was already resolved' }, 404);
      }
      if (request.method === 'POST') {
        return json({ _tag: 'PermissionNotFoundError', requestID: 'permission-1', message: 'Permission was already resolved' }, 404);
      }
      if (path.endsWith('/permission/request')) {
        return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'permission-1', sessionID: 'session-1', action: 'bash', resources: ['*'] }] });
      }
      return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'form-1', sessionID: 'session-1', fields: [] }] });
    });

    await client.question.list({ directory: '/repo' });
    await client.permission.list({ directory: '/repo' });
    const question = await client.question.reply({ requestID: 'form-1', answers: [] });
    const permission = await client.permission.reply({ requestID: 'permission-1', reply: 'once' });

    expect(question.error).toBeInstanceOf(Error);
    expect(String(question.error)).toContain('QuestionNotFoundError');
    expect(permission.error).toBeInstanceOf(Error);
    expect(String(permission.error)).toContain('PermissionNotFoundError');
  });

  test('rejects ambiguous form option labels without submitting', async () => {
    let posts = 0;
    const client = adapter(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === 'POST') {
        posts += 1;
        return new Response(null, { status: 204 });
      }
      return json({ location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } }, data: [{ id: 'form-1', sessionID: 'session-1', fields: [{ key: 'environment', type: 'string', options: [{ value: 'prod', label: 'Deploy' }, { value: 'staging', label: 'Deploy' }] }] }] });
    });

    await client.question.list({ directory: '/repo' });
    const result = await client.question.reply({ requestID: 'form-1', answers: [['Deploy']] });

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('Ambiguous option label');
    expect(posts).toBe(0);
  });

  test('fails permission and form replies explicitly when local routing is absent', async () => {
    const client = adapter(async () => { throw new Error('fetch should not run'); });
    expect((await client.permission.reply({ requestID: 'missing', reply: 'once' })).error).toBeInstanceOf(Error);
    expect((await client.question.reply({ requestID: 'missing', answers: [['yes']] })).error).toBeInstanceOf(Error);
  });

  test('maps representative text deltas without fetching session metadata', async () => {
    let requests = 0;
    const event = {
      id: 'event-1', created: 100, type: 'session.text.delta', location: { directory: '/repo' },
      data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', ordinal: 0, delta: 'hello' },
    };
    const client = adapter(async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });

    const result = await client.global.event();
    const received: GlobalEvent[] = [];
    if (result.stream) {
      for await (const item of result.stream) received.push(item);
    }

    expect(requests).toBe(1);
    expect(received).toEqual([{
      directory: '/repo',
      payload: {
        id: 'event-1', type: 'message.part.delta',
        properties: { sessionID: 'session-1', messageID: 'assistant-1', partID: 'assistant-1:text:0', field: 'text', delta: 'hello' },
      },
    }]);
  });

  test('maps file content from live tool success events to completed attachments', async () => {
    const events = [
      { id: 'event-1', created: 100, type: 'session.tool.input.started', location: { directory: '/repo' }, data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', id: 'call-1', name: 'read' } },
      { id: 'event-2', created: 101, type: 'session.tool.called', location: { directory: '/repo' }, data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', id: 'call-1', input: { path: 'report.pdf' } } },
      { id: 'event-3', created: 102, type: 'session.tool.success', location: { directory: '/repo' }, data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', id: 'call-1', content: [{ type: 'file', mime: 'application/pdf', uri: 'file:///repo/report.pdf', name: 'report.pdf' }], metadata: {} } },
    ];
    const client = adapter(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));

    const result = await client.global.event();
    const received: GlobalEvent[] = [];
    if (result.stream) {
      for await (const item of result.stream) received.push(item);
    }

    expect(received[2]?.payload).toEqual({
      id: 'event-3',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'call-1', sessionID: 'session-1', messageID: 'assistant-1', type: 'tool', callID: 'call-1', tool: 'read',
          state: {
            status: 'completed', input: { path: 'report.pdf' }, output: '', title: 'read', metadata: {}, time: { start: 100, end: 102 },
            attachments: [{ id: 'call-1:file:0', sessionID: 'session-1', messageID: 'assistant-1', type: 'file', mime: 'application/pdf', url: 'file:///repo/report.pdf', filename: 'report.pdf' }],
          },
        },
        time: 102,
      },
    });
  });
});
