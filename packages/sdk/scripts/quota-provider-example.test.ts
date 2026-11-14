import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { startExampleService } from './fixtures/example-service';
import { startUsageServer, type UsageServer } from '../examples/quota-provider/usage-server';
import { quotaProviderSchemasV1 as schemas } from '../src/service-provider-schemas';
import { QUOTA_PROVIDER_PATH, type QuotaProviderCredential } from '../src/service-providers';

// Runs the checked-in service bundle the way OpenChamber does: a loopback port
// and bearer, one `usage.read` per refresh carrying the credential OpenCode
// holds for the listed provider, and the example's fake usage API behind it.

const serviceEntry = fileURLToPath(new URL('../examples/quota-provider/service/main.js', import.meta.url));
const PROVIDER = 'ext-quota-provider';

let usage: UsageServer;
let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  usage = await startUsageServer({ token: 'demo', now: () => NOW });
  ({ service, port: servicePort } = await startExampleService({
    entry: serviceEntry,
    token: serviceToken,
    env: {
      TEAPOT_USAGE_URL: usage.origin,
    },
  }));
});

afterAll(async () => {
  service?.kill();
  await usage?.close();
});

let requests = 0;
/** One `usage.read` as OpenChamber posts it, with the credentials it picked for the listed providers. */
const read = async (credentials: Record<string, QuotaProviderCredential>) => {
  const response = await fetch(`http://127.0.0.1:${servicePort}${QUOTA_PROVIDER_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, requestId: `req-${requests += 1}`, method: 'usage.read', provider: PROVIDER, input: { credentials } }),
  });
  expect(response.status).toBe(200);
  const envelope = schemas.envelope.parse(await response.json());
  if (!envelope.ok) throw new Error(`usage.read failed: ${envelope.error.message}`);
  // The host's parse: an answer that does not match is a malformed answer, never an empty result.
  return schemas.data['usage.read'].parse(envelope.data);
};

describe('quota provider example', () => {
  test('reads usage with the key OpenCode holds for teapot, in the shape a built-in computes', async () => {
    const result = await read({ teapot: { type: 'api', key: 'demo' } });
    expect(result).toMatchObject({ ok: true, configured: true, planLabel: 'Pro' });
    expect(result.usage?.windows['5h']).toEqual({ usedPercent: 24, windowSeconds: 18_000, resetAt: usage.state.fiveHour.resetsAt, value: { kind: 'requests', count: 120 } });
    expect(result.usage?.windows.weekly).toEqual({ usedPercent: 82, windowSeconds: 604_800, resetAt: usage.state.weekly.resetsAt, value: { kind: 'requests', count: 4_100 } });
    expect(result.usage?.windows.credits_balance).toEqual({ usedPercent: null, valueLabel: '$12.50' });
    // A browser login's access token serves as the bearer too.
    expect((await read({ teapot: { type: 'oauth', access: 'demo', refresh: 'r', expires: NOW + 3_600_000 } })).ok).toBe(true);
  });

  test('a refused key, a missing credential and an API that is down each answer as a built-in would', async () => {
    expect(await read({ teapot: { type: 'api', key: 'wrong' } })).toMatchObject({ ok: false, configured: true, error: expect.stringContaining('refused the key'), usage: null });
    // Only the listed provider's entry counts; another provider's key is not the teapot key.
    expect(await read({ openrouter: { type: 'api', key: 'demo' } })).toMatchObject({ ok: false, configured: false, error: 'Not configured', usage: null });
    await usage.close();
    expect(await read({ teapot: { type: 'api', key: 'demo' } })).toMatchObject({ ok: false, configured: true, error: expect.stringContaining('did not answer'), usage: null });
  });

  test('refuses a body that is not a usage call, and a caller without the service bearer', async () => {
    const notACall = await fetch(`http://127.0.0.1:${servicePort}${QUOTA_PROVIDER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 2 }),
    });
    expect(notACall.status).toBe(400);
    const noBearer = await fetch(`http://127.0.0.1:${servicePort}${QUOTA_PROVIDER_PATH}`, { method: 'POST', body: '{}' });
    expect(noBearer.status).toBe(401);
  });
});
