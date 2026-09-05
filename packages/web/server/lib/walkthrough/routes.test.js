import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWalkthroughRoutes } from './routes.js';

// These run over real HTTP on purpose. The bug this file exists for was
// invisible to unit tests: the service and the store were both correct, and the
// response was dropped by a disconnect check that misread a healthy request.

const SOURCE = { kind: 'working-tree', scope: 'all' };

describe('walkthrough routes', () => {
  let server;
  let base;
  let releaseJob;
  let job;

  let lastArgs;
  let generateCalls = 0;

  const service = {
    async getWalkthrough(args) {
      lastArgs = args;
      return { walkthrough: null, hunks: [], hunkCount: 0, generating: Boolean(job) };
    },
    async generateWalkthrough(args) {
      lastArgs = args;
      generateCalls += 1;
      if (job) return job;
      job = new Promise((resolve) => {
        releaseJob = () => resolve({ walkthrough: { title: 'DONE' }, hunks: [], hunkCount: 1 });
      }).finally(() => { job = null; });
      return job;
    },
    async cancelWalkthroughGeneration() {
      return { cancelled: Boolean(job) };
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
    releaseJob = undefined;
    lastArgs = undefined;
    const app = express();
    app.use(express.json());
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => service });
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
    await untilGenerateCalled(seen);
    releaseJob();

    const body = await (await pending).json();

    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  it('delivers the result to a client that reconnected after a refresh', async () => {
    const controller = new AbortController();
    const seen = generateCalls;
    generate(controller.signal).catch(() => {});
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
    await untilGenerateCalled(seen);

    const response = await fetch(`${base}/api/walkthrough/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    });

    expect(await response.json()).toEqual({ cancelled: true });
    releaseJob();
  });
});
