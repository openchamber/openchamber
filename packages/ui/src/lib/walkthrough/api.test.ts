import { beforeEach, describe, expect, mock, test } from 'bun:test';

// A server older than this client does not answer 404-with-JSON: unmatched
// `/api/*` reaches the OpenCode proxy, and OpenCode serves its embedded web UI
// for any unknown path — HTML, status 200. These tests pin that the panel gets
// an actionable code instead of a JSON parser error.

let nextResponse: Response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
let requests: Array<{
  path: string;
  options: { query?: Record<string, string>; body?: string; method?: string };
}> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (
    path: string,
    options: { query?: Record<string, string>; body?: string; method?: string } = {},
  ) => {
    requests.push({ path, options });
    return nextResponse;
  }),
}));

const {
  cancelWalkthroughGeneration,
  fetchWalkthrough,
  fetchWalkthroughStage,
  generateWalkthrough,
} = await import('./api');
const { WalkthroughError } = await import('./types');
import type { SourceControlReadContext } from '@/lib/api/types';
import type { WalkthroughResult, WalkthroughTarget } from './types';

const TARGET: WalkthroughTarget = { source: { kind: 'working-tree', scope: 'all' } };
const CONTEXT = {
  provider: 'github',
  instance: 'github.com',
  accountId: 'account-a',
  repositoryId: 'repo-1',
  bindingRevision: 4,
  directory: '/repo',
  primaryRemote: 'origin',
} satisfies SourceControlReadContext;
const READ_CONTEXT_FIELDS = {
  provider: CONTEXT.provider,
  instance: CONTEXT.instance,
  accountId: CONTEXT.accountId,
  repositoryId: CONTEXT.repositoryId,
  bindingRevision: CONTEXT.bindingRevision,
  primaryRemote: CONTEXT.primaryRemote,
};
const PR_TARGET: Extract<WalkthroughTarget, { source: { kind: 'pr' } }> = {
  source: { kind: 'pr', number: 42 },
  context: CONTEXT,
};

const PR_RESULT: WalkthroughResult = {
  source: PR_TARGET.source,
  readContext: PR_TARGET.context,
  walkthrough: null,
  hunks: [],
  hunkCount: 0,
};

const html = (status: number) =>
  new Response('<!doctype html><html><body>OpenCode</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

describe('walkthrough api', () => {
  beforeEach(() => {
    nextResponse = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    requests = [];
  });

  test('reads a JSON answer', async () => {
    nextResponse = new Response(JSON.stringify({ hunkCount: 3 }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await fetchWalkthrough('/repo', TARGET);

    expect(result.hunkCount).toBe(3);
  });

  test('reports HTML served with 200 as a server without the routes', async () => {
    nextResponse = html(200);

    const error = await fetchWalkthrough('/repo', TARGET).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalkthroughError);
    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('server-unsupported');
    expect((error as Error).message).not.toContain('JSON');
  });

  test('reports a non-JSON 404 the same way', async () => {
    nextResponse = html(404);

    const error = await generateWalkthrough('/repo', TARGET).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('server-unsupported');
  });

  test('keeps a server-side failure rather than blaming the server version', async () => {
    nextResponse = new Response(JSON.stringify({ error: 'model exploded', code: 'output-exhausted' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await generateWalkthrough('/repo', TARGET).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('output-exhausted');
    expect((error as Error).message).toBe('model exploded');
  });

  test('a 5xx that is not JSON is a broken server, not a missing route', async () => {
    nextResponse = html(502);

    const error = await fetchWalkthrough('/repo', TARGET).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe(undefined);
    expect((error as Error).message).toBe('Failed to load walkthrough');
  });

  test('JSON that does not parse is reported without the parser wording', async () => {
    nextResponse = new Response('{"walkthrough":', { headers: { 'Content-Type': 'application/json' } });

    const error = await fetchWalkthrough('/repo', TARGET).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalkthroughError);
    expect((error as Error).message).toBe('The server returned a malformed walkthrough response');
  });

  test('sends PR authority with read, generate, progress, and cancel requests', async () => {
    nextResponse = new Response(JSON.stringify(PR_RESULT), {
      headers: { 'Content-Type': 'application/json' },
    });
    await fetchWalkthrough('/repo', PR_TARGET);
    nextResponse = new Response(JSON.stringify(PR_RESULT), {
      headers: { 'Content-Type': 'application/json' },
    });
    await generateWalkthrough('/repo', PR_TARGET);

    nextResponse = new Response(JSON.stringify({ stage: 'asking', readContext: CONTEXT }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await fetchWalkthroughStage('/repo', PR_TARGET);
    nextResponse = new Response(JSON.stringify({ readContext: CONTEXT }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await cancelWalkthroughGeneration('/repo', PR_TARGET);

    expect(requests[0].options.query).toEqual({
      directory: '/repo',
      source: JSON.stringify(PR_TARGET.source),
      ...READ_CONTEXT_FIELDS,
      bindingRevision: String(CONTEXT.bindingRevision),
    });
    expect(JSON.parse(requests[1].options.body ?? '')).toEqual({
      directory: '/repo',
      source: PR_TARGET.source,
      force: false,
      ...READ_CONTEXT_FIELDS,
    });
    expect(requests[2].options.query).toEqual({
      directory: '/repo',
      source: JSON.stringify(PR_TARGET.source),
      ...READ_CONTEXT_FIELDS,
      bindingRevision: String(CONTEXT.bindingRevision),
    });
    expect(JSON.parse(requests[3].options.body ?? '')).toEqual({
      directory: '/repo',
      source: PR_TARGET.source,
      ...READ_CONTEXT_FIELDS,
    });
  });

  test('rejects a legacy PR result without echoed authority', async () => {
    nextResponse = new Response(JSON.stringify({
      source: PR_TARGET.source,
      walkthrough: null,
      hunks: [],
      hunkCount: 0,
    }), { headers: { 'Content-Type': 'application/json' } });

    await expect(fetchWalkthrough('/repo', PR_TARGET)).rejects.toThrow(
      'different source-control context',
    );
  });

  test('rejects a PR result from another account', async () => {
    nextResponse = new Response(JSON.stringify({
      ...PR_RESULT,
      readContext: { ...CONTEXT, accountId: 'account-b' },
    }), { headers: { 'Content-Type': 'application/json' } });

    await expect(generateWalkthrough('/repo', PR_TARGET)).rejects.toThrow(
      'different source-control context',
    );
  });

  test('rejects progress and cancellation results without echoed authority', async () => {
    nextResponse = new Response(JSON.stringify({ stage: 'asking' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(fetchWalkthroughStage('/repo', PR_TARGET)).rejects.toThrow(
      'different source-control context',
    );

    nextResponse = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    await expect(cancelWalkthroughGeneration('/repo', PR_TARGET)).rejects.toThrow(
      'different source-control context',
    );
  });
});
