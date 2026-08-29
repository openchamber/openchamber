import { describe, expect, test, mock, beforeEach } from 'bun:test';

const defaultResponse = () => Response.json({ data: { admittedSeq: 1, id: 'msg_test', sessionID: 'ses_test', delivery: 'queue', timeCreated: 1, prompt: { text: 'hello' } } });
let nextResponse: (() => Response | Promise<Response>) = defaultResponse;
let runtimeKey = 'runtime-test';
const runtimeFetchCalls: unknown[][] = [];
const runtimeFetchMock = mock(async (...args: unknown[]) => {
  runtimeFetchCalls.push(args);
  return nextResponse();
});
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { normalizeAttachmentForAdmission: async (file: { mime: string; filename?: string; url: string }) => {
  if (file.mime === 'image/heic') return { mime: 'image/jpeg', filename: file.filename?.replace(/\.heic$/i, '.jpg'), url: 'data:image/jpeg;base64,converted' };
  if (file.mime.startsWith('text/')) return { mime: 'text/plain', filename: file.filename, url: file.url.replace(/^data:[^;,]+/, 'data:text/plain') };
  return file;
} } }));

import { buildQueueAdmissionPayload, admitToDurableQueue, clearQueueAdmissionCapabilityCache } from './queueAdmission';
import { createContextPart } from '@/lib/messages/contextParts';

const input = { runtimeKey: 'runtime-test', sessionId: 'ses_test', directory: '/repo', text: 'hello', agentMentionName: 'worker', clientMessageId: 'msg_test' };

describe('durable queue admission', () => {
  beforeEach(() => { nextResponse = defaultResponse; runtimeKey = 'runtime-test'; runtimeFetchCalls.length = 0; clearQueueAdmissionCapabilityCache(); });

  test('pins the v2 endpoint and exact payload shape', async () => {
    const result = await admitToDurableQueue(input);
    expect(result.outcome).toBe('admitted');
    if (result.outcome === 'admitted') {
      expect(result.acknowledgement.admittedSeq).toBe(1);
      expect(result.acknowledgement.id).toBe('msg_test');
      expect(result.acknowledgement.sessionID).toBe('ses_test');
    }
    const call = runtimeFetchCalls[0];
    expect(call?.[0]).toBe('/api/session/ses_test/prompt');
    const request = call?.[1] as RequestInit & { query?: unknown };
    expect(request.method).toBe('POST');
    expect(request.query).toEqual({ directory: '/repo' });
    expect(request.body).toBe(JSON.stringify({ id: 'msg_test', prompt: { text: 'hello', agents: [{ name: 'worker' }] }, delivery: 'queue' }));
    expect(buildQueueAdmissionPayload(input)).toEqual({ id: 'msg_test', prompt: { text: 'hello', agents: [{ name: 'worker' }] }, delivery: 'queue' });
  });

  test('keeps structured context on the local fallback', async () => {
    const context = { text: 'Comment on `src/app.ts`:', synthetic: true as const, metadata: { openchamberContext: {
      kind: 'code-comment' as const, source: 'diff' as const, fileLabel: 'src/app.ts', startLine: 3, endLine: 5,
      language: 'ts', code: 'const x = 1;', text: 'fix this',
    } } };
    const result = await admitToDurableQueue({ ...input, contextParts: [context] });
    expect(result.outcome).toBe('unsupported');
    expect(runtimeFetchCalls).toHaveLength(0);
  });

  test('normalizes the OpenCode v2 messageID/timestamp acknowledgement shape', async () => {
    nextResponse = () => Response.json({ data: {
      admittedSeq: 4, messageID: 'msg_test', sessionID: 'ses_test', delivery: 'queue',
      timestamp: 42, prompt: { text: 'hello' },
    } });
    const result = await admitToDurableQueue(input);
    expect(result.outcome).toBe('admitted');
    if (result.outcome === 'admitted') {
      expect(result.acknowledgement.id).toBe('msg_test');
      expect(result.acknowledgement.timeCreated).toBe(42);
    }
  });

  test('preserves a valid acknowledgement after a runtime switch so retry keeps its idempotency key', async () => {
    nextResponse = () => {
      runtimeKey = 'runtime-next';
      // The production endpoint-change event increments this same generation.
      // Tests run without a DOM, so use the exported reset directly.
      clearQueueAdmissionCapabilityCache();
      return defaultResponse();
    };

    const result = await admitToDurableQueue(input);

    if (result.outcome !== 'admitted') throw result.error;
    expect(result.outcome).toBe('admitted');
    expect(runtimeFetchCalls).toHaveLength(1);
    if (result.outcome === 'admitted') expect(result.acknowledgement.id).toBe(input.clientMessageId);
  });

  test('keeps an unverifiable OK response ambiguous after a runtime switch', async () => {
    nextResponse = () => {
      runtimeKey = 'runtime-next';
      clearQueueAdmissionCapabilityCache();
      return new Response('<html>unknown</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };

    expect((await admitToDurableQueue(input)).outcome).toBe('ambiguous');
    expect(runtimeFetchCalls).toHaveLength(1);
  });

  test('does not restore a stale unsupported verdict after a runtime switch', async () => {
    nextResponse = () => {
      runtimeKey = 'runtime-next';
      clearQueueAdmissionCapabilityCache();
      return new Response('method not allowed', { status: 405 });
    };

    expect((await admitToDurableQueue(input)).outcome).toBe('ambiguous');
    runtimeKey = 'runtime-test';
    nextResponse = defaultResponse;
    expect((await admitToDurableQueue(input)).outcome).toBe('admitted');
    expect(runtimeFetchCalls).toHaveLength(2);
  });

  test('does not retry or throw on an ambiguous transport error', async () => {
    nextResponse = () => Promise.reject(new Error('connection lost'));
    const result = await admitToDurableQueue(input);
    expect(result.outcome).toBe('ambiguous');
    expect(runtimeFetchCalls.length).toBe(1);
  });

  test('rejects an unvalidated success envelope', async () => {
    nextResponse = () => Response.json({ data: { admittedSeq: 1, id: 'wrong', sessionID: 'ses_test', delivery: 'queue', timeCreated: 1, prompt: { text: 'hello' } } });
    expect((await admitToDurableQueue(input)).outcome).toBe('ambiguous');
  });

  test('does not classify an HTTP 400 as unsupported without a capability error', async () => {
    nextResponse = () => new Response('invalid prompt', { status: 400 });
    expect((await admitToDurableQueue(input)).outcome).toBe('failed');
    nextResponse = defaultResponse;
    expect((await admitToDurableQueue(input)).outcome).toBe('admitted');
  });

  test('classifies only an explicit method rejection as unsupported', async () => {
    nextResponse = () => new Response('method not allowed', { status: 405 });
    expect((await admitToDurableQueue(input)).outcome).toBe('unsupported');
    nextResponse = () => Response.json({ data: { admittedSeq: 3, id: 'msg_test', sessionID: 'ses_test', delivery: 'queue', timeCreated: 3, prompt: { text: 'hello' } } });
    expect((await admitToDurableQueue(input)).outcome).toBe('unsupported');
  });

  test('treats an HTML success and route 404 as unsupported', async () => {
    nextResponse = () => new Response('<html>OpenCode</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await admitToDurableQueue(input)).outcome).toBe('unsupported');

    clearQueueAdmissionCapabilityCache();
    nextResponse = () => new Response('route not found', { status: 404 });
    expect((await admitToDurableQueue(input)).outcome).toBe('unsupported');
  });

  test('treats a tagged missing session and conflict as failed, never ambiguous', async () => {
    nextResponse = () => new Response(JSON.stringify({ name: 'SessionNotFoundError', message: 'session not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    expect((await admitToDurableQueue(input)).outcome).toBe('failed');

    clearQueueAdmissionCapabilityCache();
    nextResponse = () => new Response('ConflictError: already admitted', { status: 409 });
    expect((await admitToDurableQueue(input)).outcome).toBe('failed');
  });

  test('classifies rate-limit admission failures as definitive', async () => {
    nextResponse = () => new Response('rate limited', { status: 429 });
    expect((await admitToDurableQueue(input)).outcome).toBe('failed');
  });

  test('treats potentially committed HTTP failures as ambiguous', async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      clearQueueAdmissionCapabilityCache();
      runtimeFetchCalls.length = 0;
      nextResponse = () => new Response('upstream failure', { status });
      expect((await admitToDurableQueue(input)).outcome).toBe('ambiguous');
      expect(runtimeFetchCalls.length).toBe(1);
    }
  });

  test('preserves attachments in the v2 prompt shape', () => {
    expect(buildQueueAdmissionPayload({ ...input, files: [{ id: 'f', file: new File([], 'x.png'), dataUrl: 'data:image/png;base64,x', mimeType: 'image/png', filename: 'x.png', size: 1, source: 'local' }] }).prompt.files).toEqual([{ uri: 'data:image/png;base64,x', name: 'x.png' }]);
  });

  test('omits unsupported structured context from the durable prompt', () => {
    const context = createContextPart({
      kind: 'code-comment', source: 'diff', fileLabel: 'src/app.ts', startLine: 3, endLine: 5,
      language: 'ts', code: 'const x = 1;', text: 'fix this',
    });
    const payload = buildQueueAdmissionPayload({ ...input, contextParts: [context] });
    expect((payload.prompt as Record<string, unknown>).parts).toEqual(undefined);
    expect(payload.prompt.text).toBe('hello');
  });

  test('admits normalized HEIC and text files using uri/name only', async () => {
    nextResponse = () => Response.json({ data: { admittedSeq: 2, id: 'msg_test', sessionID: 'ses_test', delivery: 'queue', timeCreated: 2, prompt: { text: 'hello' } } });
    const result = await admitToDurableQueue({ ...input, files: [
      { id: 'h', file: new File([], 'photo.heic'), dataUrl: 'data:image/heic;base64,x', mimeType: 'image/heic', filename: 'photo.heic', size: 1, source: 'local' },
      { id: 't', file: new File([], 'note.md'), dataUrl: 'data:text/markdown;base64,x', mimeType: 'text/markdown', filename: 'note.md', size: 1, source: 'local' },
    ] });
    expect(result.outcome).toBe('admitted');
    const body = JSON.parse((runtimeFetchCalls[0]?.[1] as { body: string }).body);
    expect(body.prompt.files).toEqual([
      { uri: 'data:image/jpeg;base64,converted', name: 'photo.jpg' },
      { uri: 'data:text/plain;base64,x', name: 'note.md' },
    ]);
    expect(body.prompt.files.every((file: Record<string, unknown>) => !('mime' in file))).toBe(true);
  });

  test('deduplicates concurrent admission calls by client message id', async () => {
    let resolve!: (response: Response) => void;
    nextResponse = () => new Promise<Response>((r) => { resolve = r; });
    const first = admitToDurableQueue(input);
    const second = admitToDurableQueue(input);
    // The admission implementation performs async attachment normalization
    // before it invokes runtimeFetch.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    resolve(Response.json({ data: { admittedSeq: 1, id: 'msg_test', sessionID: 'ses_test', delivery: 'queue', timeCreated: 1, prompt: { text: 'hello' } } }));
    await Promise.all([first, second]);
    expect(runtimeFetchCalls.length).toBe(1);
  });

  test('passes an abort signal for the bounded admission request', async () => {
    let signal: AbortSignal | undefined;
    nextResponse = () => {
      const init = (runtimeFetchCalls[runtimeFetchCalls.length - 1]?.[1] ?? {}) as RequestInit;
      signal = init.signal ?? undefined;
      return defaultResponse();
    };
    const result = await admitToDurableQueue(input);
    expect(signal).toBeDefined();
    expect(result.outcome).toBe('admitted');
    expect(runtimeFetchCalls.length).toBe(1);
  });
});
