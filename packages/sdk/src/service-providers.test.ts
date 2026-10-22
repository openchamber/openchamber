import { describe, expect, test } from 'bun:test';

import { browserProviderResultSchema, sourceControlProviderSchemasV1 } from './service-provider-schemas.ts';
import {
  BROWSER_CONTROL_ACTIONS,
  OPENCHAMBER_HOST_CALLBACK_URL,
  SOURCE_CONTROL_OUTBOUND_PATH,
  SOURCE_CONTROL_PROVIDER_METHODS,
  SourceControlForgeError,
  createSourceControlForge,
  isBrowserControlAction,
  isSourceControlProviderMethod,
  readBrowserProviderRequest,
  readSourceControlProviderRequest,
  sourceControlProviderTimeoutMs,
} from './service-providers.ts';

describe('browser provider contract', () => {
  test('reads the body the host posts and refuses anything else', () => {
    const body = JSON.stringify({ requestId: 'req-1', action: 'browser.click', parameters: { selector: '#save' } });
    expect(readBrowserProviderRequest(body)).toEqual({
      requestId: 'req-1',
      action: 'browser.click',
      parameters: { selector: '#save' },
      context: { directory: null, sessionId: null },
    });
    const scoped = JSON.stringify({ requestId: 'req-2', action: 'browser.back', parameters: {}, context: { directory: '/repo', sessionId: 'ses_1' } });
    expect(readBrowserProviderRequest(scoped)?.context).toEqual({ directory: '/repo', sessionId: 'ses_1' });
    const select = JSON.stringify({ requestId: 'req-4', action: 'browser.select', parameters: { selector: '#country', label: 'Canada' } });
    expect(readBrowserProviderRequest(select)).toMatchObject({
      requestId: 'req-4',
      action: 'browser.select',
      parameters: { selector: '#country', label: 'Canada' },
    });
    const halfScoped = JSON.stringify({ requestId: 'req-3', action: 'browser.back', parameters: {}, context: { directory: '', sessionId: 7 } });
    expect(readBrowserProviderRequest(halfScoped)?.context).toEqual({ directory: null, sessionId: null });

    expect(readBrowserProviderRequest('not json')).toBeNull();
    expect(readBrowserProviderRequest('null')).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: '', action: 'browser.click', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.explode', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.back' }))).toBeNull();
  });

  test('the action list is the tool\'s twelve browser actions', () => {
    expect(BROWSER_CONTROL_ACTIONS).toHaveLength(12);
    expect(BROWSER_CONTROL_ACTIONS).toContain('browser.select');
    expect(BROWSER_CONTROL_ACTIONS).toContain('browser.close');
    expect(isBrowserControlAction('browser.snapshot')).toBe(true);
    expect(isBrowserControlAction('browser.close')).toBe(true);
    expect(isBrowserControlAction('projects.list')).toBe(false);
  });

  test('the host accepts ok/data and ok/error answers only', () => {
    expect(browserProviderResultSchema.safeParse({ ok: true, data: { url: 'http://a/' } }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: 'No element matches #x' }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: '' }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ data: {} }).success).toBe(false);
  });
});

describe('source-control provider contract', () => {
  const session = { instance: 'https://tea.example.com', handle: 'h-1', user: { id: 7, login: 'mona' } };
  const call = <T,>(patch?: T) => JSON.stringify({
    v: 1, requestId: 'req-1', method: 'listIssues', provider: 'ext-teahouse', session, input: { directory: '/repo', remote: 'origin', page: 1 }, ...patch,
  });

  test('reads the body the host posts and refuses anything else', () => {
    expect(readSourceControlProviderRequest(call())).toEqual({
      v: 1, requestId: 'req-1', method: 'listIssues', provider: 'ext-teahouse', session, input: { directory: '/repo', remote: 'origin', page: 1 },
    });
    expect(readSourceControlProviderRequest(call({ method: 'auth.verify', session: { ...session, user: null }, input: {} }))?.session?.user).toBeNull();
    expect(readSourceControlProviderRequest(call({ session: null }))?.session).toBeNull();

    expect(readSourceControlProviderRequest('not json')).toBeNull();
    expect(readSourceControlProviderRequest('[]')).toBeNull();
    expect(readSourceControlProviderRequest(call({ v: 2 }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ method: 'readUpload' }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ provider: '' }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ requestId: '' }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ input: [] }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ session: { ...session, handle: '' } }))).toBeNull();
    expect(readSourceControlProviderRequest(call({ session: { ...session, user: { id: '7', login: 'mona' } } }))).toBeNull();
  });

  test('forwards the auth hooks, the fifteen reads and the three mutation steps, each with its deadline', () => {
    expect(SOURCE_CONTROL_PROVIDER_METHODS.filter((method) => !method.includes('.'))).toHaveLength(15);
    expect(SOURCE_CONTROL_PROVIDER_METHODS).toHaveLength(20);
    expect(isSourceControlProviderMethod('mutation.perform')).toBe(true);
    expect(isSourceControlProviderMethod('references')).toBe(false);
    expect(sourceControlProviderTimeoutMs('changeRequestStatus')).toBe(12_000);
    expect(sourceControlProviderTimeoutMs('listIssues')).toBe(20_000);
    expect(sourceControlProviderTimeoutMs('mutation.reconcile')).toBe(30_000);
    expect(sourceControlProviderTimeoutMs('auth.probe')).toBe(15_000);
  });

  test('the forge helper posts to the callback listener with the handle and relays any forge status', async () => {
    const seen: Array<{ url: string; authorization: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = await request.text();
        seen.push({ url: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body });
        if (request.headers.get('authorization') === 'Bearer expired') {
          return Response.json({ error: { message: 'This call has ended', code: 'HANDLE_EXPIRED' } }, { status: 403 });
        }
        return Response.json({ status: 401, headers: { 'content-type': 'application/json', bogus: 3 }, body: '{"message":"token is invalid"}' });
      },
    });
    try {
      expect(() => createSourceControlForge({ env: {} })).toThrow(OPENCHAMBER_HOST_CALLBACK_URL);
      const forge = createSourceControlForge({ env: { [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${server.port}/` } });
      const answer = await forge.request('h-1', { method: 'GET', path: '/api/v1/user', query: { limit: '1' } });
      expect(answer).toEqual({ status: 401, headers: { 'content-type': 'application/json' }, body: '{"message":"token is invalid"}' });
      expect(seen[0]).toEqual({
        url: SOURCE_CONTROL_OUTBOUND_PATH,
        authorization: 'Bearer h-1',
        body: JSON.stringify({ method: 'GET', path: '/api/v1/user', query: { limit: '1' } }),
      });
      const refused = await forge.request('expired', { method: 'GET', path: '/api/v1/user' }).catch((error: Error) => error);
      expect(refused).toBeInstanceOf(SourceControlForgeError);
      expect(refused).toMatchObject({ code: 'HANDLE_EXPIRED', status: 403, message: 'This call has ended' });
    } finally {
      server.stop(true);
    }
    const down = createSourceControlForge({ env: { [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${server.port}` } });
    expect(await down.request('h', { method: 'GET', path: '/' }).catch((error: SourceControlForgeError) => error.code)).toBe('HOST_UNAVAILABLE');
  });

  const schemas = sourceControlProviderSchemasV1;
  const target = { repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: '1', owner: 'mona', name: 'tea' }, number: 3 };

  test('the host checks the envelope of every answer', () => {
    expect(schemas.envelope.safeParse({ ok: true, data: [] }).success).toBe(true);
    expect(schemas.envelope.safeParse({ ok: false, error: { message: 'Not found', status: 404, code: 'NOT_FOUND' } }).success).toBe(true);
    expect(schemas.envelope.safeParse({ ok: false, error: { message: 'x', status: 200 } }).success).toBe(false);
    expect(schemas.envelope.safeParse({ ok: false, error: { message: 'x', code: 'lower' } }).success).toBe(false);
    expect(schemas.envelope.safeParse({ ok: false, error: { message: 'x'.repeat(2_001) } }).success).toBe(false);
    expect(schemas.envelope.safeParse({ ok: true }).success).toBe(false);
  });

  test('answers the host acts on are checked deeply', () => {
    expect(schemas.data['auth.verify'].safeParse({ user: { id: 7, login: 'mona' } }).success).toBe(true);
    expect(schemas.data['auth.verify'].safeParse({ user: { id: '7', login: 'mona' } }).success).toBe(false);
    expect(schemas.data['auth.probe'].safeParse({ supported: true, version: '1.22.0' }).success).toBe(true);

    const head = schemas.data.readChangeRequestHead.safeParse({
      project: { id: '1', owner: 'mona', name: 'tea' }, headSha: 'A'.repeat(40), headBranch: 'feature', headOwner: 'mona',
    });
    expect(head.success && head.data.headSha).toBe('a'.repeat(40));
    expect(schemas.data.readChangeRequestHead.safeParse({
      project: { id: '1', owner: 'mona', name: 'tea' }, headSha: 'abc', headBranch: 'feature', headOwner: 'mona',
    }).success).toBe(false);

    const source = {
      sourceProject: { id: '2', owner: 'fork', name: 'tea' }, targetProject: { id: '1', owner: 'mona', name: 'tea' },
      classification: 'contributor-fork', headSha: 'b'.repeat(40), headRef: 'refs/heads/feature', endpoint: 'https://tea.example.com/fork/tea.git',
    };
    expect(schemas.data.resolveChangeRequestSource.safeParse(source).success).toBe(true);
    expect(schemas.data.resolveChangeRequestSource.safeParse({ ...source, classification: 'mirror' }).success).toBe(false);

    expect(schemas.data['mutation.resolveTarget'].safeParse({ providerTarget: { repoId: 1 }, target }).success).toBe(true);
    expect(schemas.data['mutation.resolveTarget'].safeParse({ providerTarget: { repoId: 1 }, target: { ...target, extra: 1 } }).success).toBe(false);
    expect(schemas.data['mutation.resolveTarget'].safeParse({ providerTarget: { blob: 'x'.repeat(5_000) }, target }).success).toBe(false);
    expect(schemas.data['mutation.perform'].safeParse({ number: 4, merged: true }).success).toBe(true);
    expect(schemas.data['mutation.perform'].safeParse({ number: 4, url: 'https://x' }).success).toBe(false);
    expect(schemas.data['mutation.reconcile'].safeParse({ state: 'succeeded', result: { number: 4 } }).success).toBe(true);
    expect(schemas.data['mutation.reconcile'].safeParse({ state: 'running' }).success).toBe(false);

    expect(schemas.data.liveSummaries.safeParse({
      summaries: [{ owner: 'mona', repo: 'tea', number: 3, state: 'open', draft: false, title: 'T', mergeable: null, mergeableState: null, checks: null }],
      issueSummaries: [{ owner: 'mona', repo: 'tea', number: 4, title: 'I', state: 'completed' }],
    }).success).toBe(true);
    expect(schemas.data.liveSummaries.safeParse({ summaries: [], issueSummaries: [{ owner: 'mona', repo: 'tea', number: 4, title: 'I', state: 'gone' }] }).success).toBe(false);

    const project = { provider: 'ext-teahouse', instance: 'https://tea.example.com', id: '1', owner: 'mona', name: 'tea', url: 'https://tea.example.com/mona/tea' };
    const status = { identity: { provider: 'ext-teahouse', instance: 'https://tea.example.com' }, project, branch: 'feature', changeRequest: null };
    expect(schemas.data.changeRequestStatus.safeParse(status).success).toBe(true);
    expect(schemas.data.changeRequestStatus.safeParse({ ...status, changeRequest: { number: 3 } }).success).toBe(false);
    expect(schemas.data.changeRequestStatus.safeParse({ ...status, secret: 'x' }).success).toBe(false);
  });

  test('reads the UI parses itself pass as any JSON object or array', () => {
    expect(schemas.data.listIssues.safeParse({ items: [], page: 1, hasMore: false }).success).toBe(true);
    expect(schemas.data.projectBranches.safeParse(['main']).success).toBe(true);
    expect(schemas.data.listIssues.safeParse('items').success).toBe(false);
    expect(schemas.data.listIssues.safeParse(null).success).toBe(false);
  });

  test('the outbound proxy takes only a path on the instance and the allowed headers', () => {
    expect(schemas.outboundRequest.safeParse({ method: 'POST', path: '/api/v1/repos/mona/tea/pulls', headers: { 'content-type': 'application/json' }, body: '{}' }).success).toBe(true);
    expect(schemas.outboundRequest.safeParse({ method: 'GET', path: '//evil.example/x' }).success).toBe(false);
    expect(schemas.outboundRequest.safeParse({ method: 'GET', path: 'https://evil.example/x' }).success).toBe(false);
    expect(schemas.outboundRequest.safeParse({ method: 'GET', path: '/x', headers: { authorization: 'token x' } }).success).toBe(false);
    expect(schemas.outboundRequest.safeParse({ method: 'HEAD', path: '/x' }).success).toBe(false);
  });
});
