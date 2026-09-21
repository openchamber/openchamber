import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelWalkthroughGeneration as clientCancelWalkthroughGeneration,
  fetchWalkthrough as clientFetchWalkthrough,
  fetchWalkthroughStage as clientFetchWalkthroughStage,
  generateWalkthrough as clientGenerateWalkthrough,
} from '../../../../ui/src/lib/walkthrough/api.ts';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url.ts';
import { registerWalkthroughRoutes } from './routes.js';

// These run over real HTTP on purpose. The bug this file exists for was
// invisible to unit tests: the service and the store were both correct, and the
// response was dropped by a disconnect check that misread a healthy request.

const SOURCE = { kind: 'working-tree', scope: 'all' };
const PR_SOURCE = { kind: 'pr', number: 22 };
const PR_CONTEXT = {
  provider: 'github',
  instance: 'github.com',
  accountId: 'github.com#7',
  repositoryId: 'repo-1',
  bindingRevision: 4,
  primaryRemote: 'upstream',
};

describe('walkthrough routes', () => {
  let server;
  let base;
  let releaseJob;
  let job;
  let generationRequestCount;

  let lastArgs;
  let getWalkthroughService;
  let validateReadContext;
  let generateCalls = 0;

  const service = {
    async getPullRequestDiff(directory, number, readContext, options) {
      lastArgs = { directory, number, readContext, options };
      if (number === 99) throw Object.assign(new Error('GitHub unavailable'), { statusCode: 503 });
      return { patch: number === 1 ? '' : 'diff --git a/a.ts b/a.ts\n' };
    },
    async getWalkthrough(args) {
      lastArgs = args;
      const result = {
        source: args.source,
        walkthrough: null,
        hunks: [],
        hunkCount: 0,
        generating: Boolean(job),
      };
      if (args.readContext) result.readContext = args.readContext;
      return result;
    },
    async generateWalkthrough(args) {
      lastArgs = args;
      generationRequestCount += 1;
      generateCalls += 1;
      if (job) return job;
      job = new Promise((resolve) => {
        releaseJob = () => {
          const result = {
            source: args.source,
            walkthrough: { title: 'DONE' },
            hunks: [],
            hunkCount: 1,
          };
          if (args.readContext) result.readContext = args.readContext;
          resolve(result);
        };
      }).finally(() => { job = null; });
      return job;
    },
    async cancelWalkthroughGeneration(args) {
      const result = { cancelled: Boolean(job) };
      if (args.readContext) result.readContext = args.readContext;
      return result;
    },
    async getRepositoryRootFor() {
      return { repoRoot: '/repo', sourceKey: 'pr:22' };
    },
    getGenerationStage() {
      return job ? 'asking' : null;
    },
  };

  const generate = (signal) => fetch(`${base}/api/walkthrough/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    signal,
  });

  beforeEach(async () => {
    job = null;
    generationRequestCount = 0;
    releaseJob = undefined;
    lastArgs = undefined;
    const app = express();
    app.use(express.json());
    getWalkthroughService = vi.fn(async () => service);
    validateReadContext = vi.fn(async (context) => ({ ...context, instance: 'github.com' }));
    registerWalkthroughRoutes(app, { getWalkthroughService, validateReadContext });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    // A response a failed test never received keeps its keep-alive socket
    // open, and server.close() would wait on it until the hook timeout.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  // Resolves once the route has asked the service to generate one more time
  // than `seen`. A fixed sleep assumed the request had arrived by then; on a
  // loaded runner it had not, and the step that followed acted on a request
  // the server had not seen yet.
  const untilGenerateCalled = async (seen) => {
    for (let attempt = 0; attempt < 300 && generateCalls <= seen; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (generateCalls <= seen) throw new Error('the route never asked the service to generate');
  };

  it('answers a generation request that nobody interrupted', async () => {
    const seen = generateCalls;
    const pending = generate();
    await vi.waitFor(() => expect(generationRequestCount).toBe(1));
    await untilGenerateCalled(seen);
    releaseJob();

    const body = await (await pending).json();

    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  const prDiff = (source, context = PR_CONTEXT) => fetch(`${base}/api/walkthrough/pr-diff?${new URLSearchParams({
    directory: '/repo',
    source: JSON.stringify(source),
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, String(value)])),
  })}`);

  it('serves the published PR snapshot with its repository, without generating', async () => {
    const source = { kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } };
    const before = generateCalls;
    const response = await prDiff(source);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('diff --git a/a.ts b/a.ts\n');
    // The account and repository come from the validated binding context; the
    // named repository travels only as something to check against it.
    expect(lastArgs).toEqual({
      directory: '/repo',
      number: 42,
      readContext: expect.objectContaining({ accountId: PR_CONTEXT.accountId, primaryRemote: PR_CONTEXT.primaryRemote }),
      options: { allowEmpty: true, sourceRepo: source.sourceRepo },
    });
    expect(validateReadContext).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo', accountId: PR_CONTEXT.accountId }));
    expect(generateCalls).toBe(before);
  });

  it('reads no pull request diff without a validated binding context', async () => {
    validateReadContext.mockRejectedValue(Object.assign(new Error('Binding changed'), { code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT' }));
    const response = await prDiff({ kind: 'pr', number: 42 });
    expect(response.status).toBe(400);
    expect(lastArgs).toBeUndefined();
  });

  it('distinguishes empty PRs, upstream failure, and invalid sources', async () => {
    const request = (source) => prDiff(source);
    const empty = await request({ kind: 'pr', number: 1 });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe('');
    expect((await request({ kind: 'pr', number: 99 })).status).toBe(503);
    for (const source of [{ kind: 'pr', number: -1 }, { kind: 'branch', baseRef: 'main', headRef: 'feature' }, { kind: 'pr', number: 1, sourceRepo: { owner: '../bad', repo: 'repo' } }]) {
      expect((await request(source)).status).toBe(400);
    }
  });

  it('delivers the result to a client that reconnected after a refresh', async () => {
    const controller = new AbortController();
    const seen = generateCalls;
    generate(controller.signal).catch(() => {});
    await vi.waitFor(() => expect(generationRequestCount).toBe(1));
    await untilGenerateCalled(seen);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The reloaded page sees work in progress and re-attaches to it.
    const read = await (await fetch(
      `${base}/api/walkthrough?directory=/repo&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    )).json();
    expect(read.generating).toBe(true);

    const seenBeforeReattach = generateCalls;
    const reattached = generate();
    await vi.waitFor(() => expect(generationRequestCount).toBe(2));
    await untilGenerateCalled(seenBeforeReattach);
    releaseJob();

    const body = await (await reattached).json();
    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  it('rejects a request without a directory before touching the service', async () => {
    const response = await fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SOURCE }),
    });

    expect(response.status).toBe(400);
    expect(job).toBeNull();
  });

  // The language belongs to the request, not to a setting, so both the read
  // and the generation have to carry it: readiness is computed from a prompt
  // that contains the language instruction.
  it('carries the requested language into the service', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );
    expect(lastArgs.language).toBe('uk');

    const seen = generateCalls;
    const pending = fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE, language: 'ja' }),
    });
    await vi.waitFor(() => expect(generationRequestCount).toBe(1));
    await untilGenerateCalled(seen);
    releaseJob();
    await pending;

    expect(lastArgs.language).toBe('ja');
  });

  it('ignores a language that is not a string', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language[]=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );

    expect(lastArgs.language).toBeUndefined();
  });

  it('cancels through its own endpoint rather than a dropped connection', async () => {
    const seen = generateCalls;
    generate().catch(() => {});
    await vi.waitFor(() => expect(generationRequestCount).toBe(1));
    await untilGenerateCalled(seen);

    const response = await fetch(`${base}/api/walkthrough/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    });

    expect(await response.json()).toEqual({ cancelled: true });
    releaseJob();
  });

  it.each([
    ['read', () => fetch(`${base}/api/walkthrough?directory=/repo&source=${encodeURIComponent(JSON.stringify(PR_SOURCE))}`)],
    ['generate', () => fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: '/repo', source: PR_SOURCE }),
    })],
    ['progress', () => fetch(`${base}/api/walkthrough/progress?directory=/repo&source=${encodeURIComponent(JSON.stringify(PR_SOURCE))}`)],
    ['cancel', () => fetch(`${base}/api/walkthrough/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: '/repo', source: PR_SOURCE }),
    })],
  ])('validates PR context before service work for %s', async (_name, request) => {
    const failure = Object.assign(new Error('Source control read context is required'), {
      code: 'INVALID_SOURCE_CONTROL_BINDING',
    });
    validateReadContext.mockRejectedValue(failure);

    const response = await request();

    expect(response.status).toBe(400);
    expect(getWalkthroughService).not.toHaveBeenCalled();
    expect(validateReadContext).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      provider: undefined,
      bindingRevision: Number.NaN,
    }));
  });

  it('passes the trusted immutable context to a PR read', async () => {
    const query = new URLSearchParams({
      directory: '/repo',
      source: JSON.stringify(PR_SOURCE),
      ...Object.fromEntries(Object.entries(PR_CONTEXT).map(([key, value]) => [key, String(value)])),
    });

    await fetch(`${base}/api/walkthrough?${query}`);

    expect(lastArgs.readContext).toEqual({ ...PR_CONTEXT, directory: '/repo' });
    expect(validateReadContext.mock.invocationCallOrder[0])
      .toBeLessThan(getWalkthroughService.mock.invocationCallOrder[0]);
  });

  it('accepts the UI client wire shape for every PR walkthrough route', async () => {
    const previousResolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: base });
    const target = { source: PR_SOURCE, context: { ...PR_CONTEXT, directory: '/repo' } };

    try {
      await clientFetchWalkthrough('/repo', target);

      const generation = clientGenerateWalkthrough('/repo', target);
      await vi.waitFor(() => expect(generationRequestCount).toBe(1));
      releaseJob();
      await generation;

      expect(await clientFetchWalkthroughStage('/repo', target)).toBeNull();
      await clientCancelWalkthroughGeneration('/repo', target);
    } finally {
      setRuntimeUrlResolver(previousResolver);
    }

    expect(validateReadContext).toHaveBeenCalledTimes(4);
    for (const [context] of validateReadContext.mock.calls) {
      expect(context).toEqual({ ...PR_CONTEXT, directory: '/repo' });
    }
  });

  it('rejects a validated non-GitHub PR context explicitly', async () => {
    validateReadContext.mockResolvedValue({ ...PR_CONTEXT, directory: '/repo', provider: 'gitlab', instance: 'https://gitlab.com' });
    const response = await fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: PR_SOURCE, ...PR_CONTEXT, provider: 'gitlab', instance: 'https://gitlab.com' }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'UNSUPPORTED_WALKTHROUGH_PROVIDER' });
    expect(getWalkthroughService).not.toHaveBeenCalled();
  });
});
