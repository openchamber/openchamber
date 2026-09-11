import { beforeEach, describe, expect, mock, test } from 'bun:test';

// A server older than this client does not answer 404-with-JSON: unmatched
// `/api/*` reaches the OpenCode proxy, and OpenCode serves its embedded web UI
// for any unknown path — HTML, status 200. These tests pin that the panel gets
// an actionable code instead of a JSON parser error.

let nextResponse: Response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => nextResponse),
}));

const { fetchWalkthrough, generateWalkthrough } = await import('./api');
const { WalkthroughError } = await import('./types');
import type { WalkthroughSource } from './types';

const SOURCE: WalkthroughSource = { kind: 'working-tree', scope: 'all' };

const html = (status: number) =>
  new Response('<!doctype html><html><body>OpenCode</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

describe('walkthrough api', () => {
  beforeEach(() => {
    nextResponse = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });

  test('reads a JSON answer', async () => {
    nextResponse = new Response(JSON.stringify({ hunkCount: 3 }), {
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await fetchWalkthrough('/repo', SOURCE);

    expect(result.hunkCount).toBe(3);
  });

  test('reports HTML served with 200 as a server without the routes', async () => {
    nextResponse = html(200);

    const error = await fetchWalkthrough('/repo', SOURCE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalkthroughError);
    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('server-unsupported');
    expect((error as Error).message).not.toContain('JSON');
  });

  test('reports a non-JSON 404 the same way', async () => {
    nextResponse = html(404);

    const error = await generateWalkthrough('/repo', SOURCE).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('server-unsupported');
  });

  test('keeps a server-side failure rather than blaming the server version', async () => {
    nextResponse = new Response(JSON.stringify({ error: 'model exploded', code: 'output-exhausted' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await generateWalkthrough('/repo', SOURCE).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe('output-exhausted');
    expect((error as Error).message).toBe('model exploded');
  });

  test('a 5xx that is not JSON is a broken server, not a missing route', async () => {
    nextResponse = html(502);

    const error = await fetchWalkthrough('/repo', SOURCE).catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof WalkthroughError>).code).toBe(undefined);
    expect((error as Error).message).toBe('Failed to load walkthrough');
  });

  test('JSON that does not parse is reported without the parser wording', async () => {
    nextResponse = new Response('{"walkthrough":', { headers: { 'Content-Type': 'application/json' } });

    const error = await fetchWalkthrough('/repo', SOURCE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalkthroughError);
    expect((error as Error).message).toBe('The server returned a malformed walkthrough response');
  });
});
