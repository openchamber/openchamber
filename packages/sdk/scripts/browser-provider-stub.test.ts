import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { startExampleService } from './fixtures/example-service';
import { SURFACE_FRAME_PATH, SURFACE_SEQ_HEADER } from '../src/service-surface';

// Runs the checked-in browser provider stub the way OpenChamber does, and reads
// the state endpoint the stub exposes. The host long-polls /surface/frame and
// polls again after every 204, so the stub's waiter list has to end each poll,
// timed out or answered, where it started.

const serviceEntry = fileURLToPath(new URL('../examples/browser-provider-stub/service/main.js', import.meta.url));

let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');

const authHeaders = () => ({ authorization: `Bearer ${serviceToken}` });

const frame = (query: string) => fetch(`http://127.0.0.1:${servicePort}${SURFACE_FRAME_PATH}?${query}`, { headers: authHeaders() });

beforeAll(async () => {
  ({ service, port: servicePort } = await startExampleService({ entry: serviceEntry, token: serviceToken }));
});

afterAll(() => {
  service?.kill();
});

describe('browser provider stub surface', () => {
  test('idle long-polls that time out leave no waiter behind', async () => {
    const current = await frame('after=0&wait=0');
    expect(current.status).toBe(200);
    const seq = current.headers.get(SURFACE_SEQ_HEADER);
    expect(seq).toMatch(/^\d+$/);

    // A nonzero wait, so each poll parks a waiter until its timer fires.
    const firstIdle = await frame(`after=${seq}&wait=200`);
    const secondIdle = await frame(`after=${seq}&wait=200`);
    expect(firstIdle.status).toBe(204);
    expect(secondIdle.status).toBe(204);

    const state = await fetch(`http://127.0.0.1:${servicePort}/state`, { headers: authHeaders() });
    expect(await state.json()).toMatchObject({ waiters: 0 });
  });
});
