import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';
import { getMultiRunIdentity, type MultiRunIdentity } from './identity';

const identity: Omit<MultiRunIdentity, 'key'> = {
  group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
  groupSlug: 'bench', providerID: 'openrouter', modelID: 'vendor/model', role: 'run',
};

const recordSchema = z.record(z.string(), z.json());

/** The RFC 7386 merge the OpenChamber metadata route performs server-side. */
const mergePatch = (current: Metadata, patch: Metadata): Metadata => {
  const base: Metadata = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete base[key]; continue; }
    const nested = recordSchema.safeParse(value);
    if (!nested.success) { base[key] = value; continue; }
    const previous = recordSchema.safeParse(base[key]);
    base[key] = mergePatch(previous.success ? previous.data : {}, nested.data);
  }
  return base;
};

const calls: string[] = [];
let stored: Metadata = {};
type CreationFailure = { rejectUpdate?: boolean; omitSavedMarker?: boolean; switchAfterCreate?: boolean };
let options: CreationFailure = {};
let current = true;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    createSession: async (params: { title?: string; metadata?: Metadata }, directory?: string | null): Promise<Session> => {
      expect(directory).toBe('/repo');
      calls.push('create');
      // What another feature already stored for this session before creation.
      stored = mergePatch({
        external: 'preserve',
        openchamber: { goal: { status: 'active' }, reviewSessionID: 'review-id' },
      }, params.metadata ?? {});
      const session: Session = {
        id: 'ses_new', projectID: 'p', directory: '/repo', title: params.title ?? '',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 }, metadata: stored,
      };
      expect(getMultiRunIdentity(session)).toBeNull();
      if (options.switchAfterCreate) current = false;
      return session;
    },
    deleteSession: async (id: string, directory?: string | null) => {
      expect(id).toBe('ses_new');
      expect(directory).toBe('/repo');
      calls.push('delete');
      return true;
    },
  },
}));

mock.module('@/sync/session-archive-batch', () => ({
  requestSessionMetadataUpdate: async (_sessionID: string, patch: Metadata) => {
    calls.push('metadata');
    if (options.rejectUpdate) return { outcome: 'unavailable' as const, reason: 'write failed' };
    stored = options.omitSavedMarker ? {} : mergePatch(stored, patch);
    return { outcome: 'updated' as const, metadata: stored };
  },
}));

const { createMultiRunSession } = await import('./createSession');

const fixture = (next: CreationFailure = {}) => {
  calls.length = 0;
  stored = {};
  current = true;
  options = next;
  return { calls, assertCurrent: () => { if (!current) throw new Error('Runtime changed'); } };
};

describe('multi-run creation', () => {
  for (const role of ['run', 'fusion'] as const) test(`binds ${role} to its actual session ID before returning it`, async () => {
    const testApi = fixture();
    const result = await createMultiRunSession({ title: 'any title', directory: '/repo', identity: { ...identity, role } }, testApi.assertCurrent);
    expect(getMultiRunIdentity(result)).toMatchObject({ role, modelID: 'vendor/model' });
    expect(result.metadata?.external).toBe('preserve');
    expect(result.metadata?.openchamber).toMatchObject({ goal: { status: 'active' }, reviewSessionID: 'review-id' });
    expect(getMultiRunIdentity({ ...result, id: 'fork' })).toBeNull();
    expect(testApi.calls).toEqual(['create', 'metadata']);
  });

  for (const failure of [{ rejectUpdate: true }, { omitSavedMarker: true }]) test(`rejects an unbound session: ${JSON.stringify(failure)}`, async () => {
    const testApi = fixture(failure);
    await expect(createMultiRunSession({ title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent)).rejects.toThrow();
    expect(testApi.calls).toEqual(['create', 'metadata', 'delete']);
  });

  test('a runtime switch prevents binding, publishing and cleanup through the new runtime', async () => {
    const testApi = fixture({ switchAfterCreate: true });
    await expect(createMultiRunSession({ title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent)).rejects.toThrow('Runtime changed');
    expect(testApi.calls).toEqual(['create']);
  });
});
