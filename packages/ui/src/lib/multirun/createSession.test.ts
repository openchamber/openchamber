import { describe, expect, test } from 'bun:test';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { createMultiRunSession } from './createSession';
import { getMultiRunIdentity, withMultiRunMembership, type MultiRunIdentity } from './identity';

const identity: Omit<MultiRunIdentity, 'key'> = {
  group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
  groupSlug: 'bench', providerID: 'openrouter', modelID: 'vendor/model', role: 'run',
};
const bodySchema = z.object({ title: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() });

function fixture(options: { rejectUpdate?: boolean; omitSavedMarker?: boolean; switchAfterCreate?: boolean } = {}) {
  const calls: string[] = [];
  let current = true;
  let stored: Session = { id: 'ses_new', slug: 'new', projectID: 'p', directory: '/repo', title: '', version: '1', time: { created: 1, updated: 1 } };
  const client = createOpencodeClient({
    baseUrl: 'http://multirun.test',
    fetch: async (request) => {
      const req = new Request(request);
      const url = new URL(req.url);
      expect(url.searchParams.get('directory')).toBe('/repo');
      calls.push(req.method);
      if (req.method === 'POST') {
        const body = bodySchema.parse(await req.json());
        stored = { ...stored, ...body };
        expect(getMultiRunIdentity(stored)).toBeNull();
        if (options.switchAfterCreate) current = false;
      }
      if (req.method === 'GET') {
        stored = { ...stored, metadata: withMultiRunMembership({ metadata: {
          external: 'preserve', openchamber: { goal: { status: 'active' }, reviewSessionID: 'review-id' },
        } }, { ...identity, role: 'run', version: 1, sessionID: null }) };
      }
      if (req.method === 'PATCH') {
        if (options.rejectUpdate) return Response.json({ error: 'write failed' }, { status: 500 });
        const body = bodySchema.parse(await req.json());
        stored = { ...stored, ...body };
        if (options.omitSavedMarker) stored.metadata = {};
      }
      if (req.method === 'DELETE') return Response.json(true);
      return Response.json(stored);
    },
  });
  const assertCurrent = () => { if (!current) throw new Error('Runtime changed'); };
  return { client, calls, assertCurrent };
}

describe('multi-run creation', () => {
  for (const role of ['run', 'fusion'] as const) test(`binds ${role} to its actual session ID before returning it`, async () => {
    const testApi = fixture();
    const result = await createMultiRunSession(testApi.client, { title: 'any title', directory: '/repo', identity: { ...identity, role } }, testApi.assertCurrent);
    expect(getMultiRunIdentity(result)).toMatchObject({ role, modelID: 'vendor/model' });
    expect(result.metadata?.external).toBe('preserve');
    expect(result.metadata?.openchamber).toMatchObject({ goal: { status: 'active' }, reviewSessionID: 'review-id' });
    expect(getMultiRunIdentity({ ...result, id: 'fork' })).toBeNull();
    expect(testApi.calls).toEqual(['POST', 'GET', 'PATCH']);
  });

  for (const failure of [{ rejectUpdate: true }, { omitSavedMarker: true }]) test(`rejects an unbound session: ${JSON.stringify(failure)}`, async () => {
    const testApi = fixture(failure);
    await expect(createMultiRunSession(testApi.client, { title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent)).rejects.toThrow();
    expect(testApi.calls).toEqual(['POST', 'GET', 'PATCH', 'DELETE']);
  });

  test('a runtime switch prevents binding, publishing and cleanup through the new runtime', async () => {
    const testApi = fixture({ switchAfterCreate: true });
    await expect(createMultiRunSession(testApi.client, { title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent)).rejects.toThrow('Runtime changed');
    expect(testApi.calls).toEqual(['POST']);
  });
});
