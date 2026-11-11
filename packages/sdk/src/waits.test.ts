import { describe, expect, test } from 'bun:test';

import type { JsonValue } from './contract.ts';
import { WAIT_STATE_MAX, WAIT_SUMMARY_MAX, readWaitCheckRequest, readWaitStartRequest } from './waits.ts';
import { waitArgsSchema, waitCheckOutcomeSchema, waitCheckResultSchema, waitStartResultSchema } from './waits-schemas.ts';

describe('wait arguments', () => {
  const params = { seconds: { type: 'number', required: true }, note: { type: 'string' } } as const;
  const read = (schema: ReturnType<typeof waitArgsSchema>, args: JsonValue) => {
    const parsed = schema.safeParse(args);
    return parsed.success ? { ok: true, args: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message };
  };

  test('keep declared arguments of the declared type', () => {
    expect(read(waitArgsSchema(params), { seconds: 30 })).toEqual({ ok: true, args: { seconds: 30 } });
    expect(read(waitArgsSchema(params), { seconds: 30, note: 'deploy' })).toEqual({ ok: true, args: { seconds: 30, note: 'deploy' } });
    expect(read(waitArgsSchema(), {})).toEqual({ ok: true, args: {} });
  });

  test('refuse a missing, mistyped or undeclared argument with a reason the agent can act on', () => {
    expect(read(waitArgsSchema(params), {})).toEqual({ ok: false, error: 'Argument "seconds" is required' });
    expect(read(waitArgsSchema(params), { seconds: '30' })).toEqual({ ok: false, error: 'Argument "seconds" must be a number' });
    expect(read(waitArgsSchema(params), { seconds: Number.NaN })).toEqual({ ok: false, error: 'Argument "seconds" must be a number' });
    expect(read(waitArgsSchema(params), { seconds: 1, url: 'x' })).toEqual({ ok: false, error: 'Unknown argument "url"; this wait takes seconds, note' });
    expect(read(waitArgsSchema(), { url: 'x' })).toEqual({ ok: false, error: 'Unknown argument "url"; this wait takes none' });
    expect(read(waitArgsSchema(params), ['x'])).toEqual({ ok: false, error: 'args must be an object' });
  });
});

describe('wait wire', () => {
  const start = { v: 1, requestId: 'req-1', wait: { id: 'wait_1', type: 'timer', args: { seconds: 5 }, session: { id: 'ses_1', directory: '/repo' } } };
  const check = { v: 1, requestId: 'req-2', waits: [{ id: 'wait_1', type: 'timer', args: { seconds: 5 }, state: { due: 1 } }] };

  test('a service reads the requests OpenChamber posts', () => {
    expect(readWaitStartRequest(JSON.stringify(start))).toEqual(start);
    expect(readWaitStartRequest(JSON.stringify({ ...start, wait: { ...start.wait, session: { id: 'ses_1', directory: null } } }))?.wait.session.directory).toBeNull();
    expect(readWaitCheckRequest(JSON.stringify(check))).toEqual(check);
    expect(readWaitCheckRequest(JSON.stringify({ ...check, waits: [{ ...check.waits[0], state: null }] }))?.waits[0]?.state).toBeNull();
  });

  test('a body of another version or shape is not a request', () => {
    expect(readWaitStartRequest(JSON.stringify({ ...start, v: 2 }))).toBeNull();
    expect(readWaitStartRequest(JSON.stringify({ ...start, wait: { ...start.wait, args: { nested: {} } } }))).toBeNull();
    expect(readWaitStartRequest('not json')).toBeNull();
    expect(readWaitCheckRequest(JSON.stringify({ ...check, waits: [{ id: 'wait_1', type: 'timer', args: {} }] }))).toBeNull();
    expect(readWaitCheckRequest(JSON.stringify([]))).toBeNull();
  });

  test('the host takes only well-formed answers', () => {
    expect(waitStartResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(waitStartResultSchema.safeParse({ ok: true, state: { due: 1 }, label: '5 s' }).success).toBe(true);
    expect(waitStartResultSchema.safeParse({ ok: false, error: 'No such deploy' }).success).toBe(true);
    expect(waitStartResultSchema.safeParse({ ok: true, state: 'x'.repeat(WAIT_STATE_MAX) }).success).toBe(false);
    expect(waitStartResultSchema.safeParse({ ok: false }).success).toBe(false);

    // The envelope takes any entries: each is read on its own.
    expect(waitCheckResultSchema.safeParse({ results: [] }).success).toBe(true);
    expect(waitCheckResultSchema.safeParse({ results: [{ id: 'wait_1', fired: true }] }).success).toBe(true);
    expect(waitCheckResultSchema.safeParse({ ok: true }).success).toBe(false);

    expect(waitCheckOutcomeSchema.safeParse({ id: 'wait_1', fired: false }).success).toBe(true);
    expect(waitCheckOutcomeSchema.safeParse({ id: 'wait_2', fired: true, summary: 'Deploy is live' }).success).toBe(true);
    expect(waitCheckOutcomeSchema.safeParse({ id: 'wait_1', fired: true }).success).toBe(false);
    expect(waitCheckOutcomeSchema.safeParse({ id: 'wait_1', fired: true, summary: 'x'.repeat(WAIT_SUMMARY_MAX + 1) }).success).toBe(false);
    expect(waitCheckOutcomeSchema.safeParse({ id: 'wait_1', fired: false, state: 'x'.repeat(WAIT_STATE_MAX) }).success).toBe(false);
  });
});
