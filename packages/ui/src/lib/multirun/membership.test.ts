import { describe, expect, test } from 'bun:test';
// This file also guards initialization from the registration-store entry path.
// Run it in its own process: importing parent creation first masked a circular
// initialization crash, which the repository's isolated runner must catch.
import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';
import { attachSessionToRun, detachSessionFromRun, saveFusionGuidance } from './membership';
import { buildMultiRunIndex } from './runs';

const group = { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' } as const;
const session = (id: string, member = false): Session => {
  const value: Session = {
    id, projectID: 'project', directory: `/repo/${id}`, title: 'bench/provider/model',
    model: { providerID: 'provider', id: 'model' },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, metadata: { external: 'keep', openchamber: { artifacts: ['report.md'] } },
  };
  if (member) value.metadata = withMultiRunMembership(value, {
    version: 1, sessionID: id, group, groupSlug: 'bench', providerID: 'provider', modelID: 'model', role: 'run',
  });
  return value;
};

// Oracle: RFC 7386 merging plus the requested membership transition model.
// This test server stores complete conversations untouched by metadata writes.
const recordSchema = z.record(z.string(), z.json());
const merge = (base: Metadata, patch: Metadata): Metadata => {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete next[key]; continue; }
    const nested = recordSchema.safeParse(value);
    const previous = recordSchema.safeParse(next[key]);
    next[key] = nested.success ? merge(previous.success ? previous.data : {}, nested.data) : value;
  }
  return next;
};

function fixture() {
  const anchor = session('a', true);
  const sibling = session('b', true);
  const imported = session('c');
  // The imported conversation title happens to match a legacy naming pattern.
  imported.metadata = { ...imported.metadata, openchamber: { artifacts: ['report.md'], multirunDetached: true } };
  const stored = new Map([anchor, sibling, imported].map((item) => [item.id, item]));
  const calls: string[] = [];
  let failWrite = false;
  const io: Parameters<typeof attachSessionToRun>[1] = {
    read: async (id, directory) => {
      calls.push(`read:${id}`);
      const value = stored.get(id);
      if (!value || value.directory !== directory) throw new Error('Missing session');
      return value;
    },
    write: async (id, patch) => {
      calls.push(`write:${id}`);
      if (failWrite) return { outcome: 'unavailable', reason: 'test failure' };
      const current = stored.get(id);
      if (!current) throw new Error('Missing session');
      const metadata = merge(current.metadata ?? {}, patch);
      stored.set(id, { ...current, metadata });
      return { outcome: 'updated', metadata };
    },
    publish: (value) => { calls.push(`publish:${value.id}`); return value; },
    primaryRoot: async (directory) => directory.startsWith('/other/') ? '/other' : '/repo',
  };
  const run = [...buildMultiRunIndex([anchor, sibling], () => '/repo').runs.values()][0];
  if (!run) throw new Error('Empty premise: no run');
  return { anchor, imported, sibling, stored, calls, run, io, fail: () => { failWrite = true; } };
}

describe('multi-run membership', () => {
  test('another worktree of the same repository can join even with a different native project ID', async () => {
    const f = fixture();
    f.stored.set(f.imported.id, { ...f.imported, projectID: 'old-worktree-location-id' });
    const attached = await attachSessionToRun({ run: f.run, anchor: f.anchor, session: f.imported }, f.io);
    expect(getMultiRunIdentity(attached)?.key).toBe(f.run.key);
    expect(attached.directory).toBe(f.imported.directory);
  });
  test('saved guidance survives revisiting the session and leaves its work and membership intact', async () => {
    const f = fixture();
    await saveFusionGuidance({ session: f.anchor, runKey: f.run.key, guidance: ' Keep its error handling ' }, f.io);
    const saved = f.stored.get(f.anchor.id);
    if (!saved) throw new Error('Lost source');
    expect(getMultiRunIdentity(saved)).toMatchObject({ key: f.run.key, guidance: 'Keep its error handling' });
    expect(saved.directory).toBe(f.anchor.directory);
    expect(saved.metadata?.openchamber).toMatchObject({ artifacts: ['report.md'] });
  });
  test('imports existing work as a new prompt variant without changing the session or siblings', async () => {
    const f = fixture();
    const attached = await attachSessionToRun({ run: f.run, anchor: f.anchor, session: f.imported }, f.io);
    expect(getMultiRunIdentity(attached)).toMatchObject({ key: f.run.key, role: 'run', runGroup: 'g2' });
    expect(attached.directory).toBe(f.imported.directory);
    expect(attached.title).toBe(f.imported.title);
    expect(attached.metadata?.external).toBe('keep');
    expect(attached.metadata?.openchamber).toMatchObject({ artifacts: ['report.md'] });
    expect(f.stored.get(f.sibling.id)).toBe(f.sibling);
    expect(f.calls).toEqual(['read:c', 'read:a', 'write:c', 'publish:c']);
  });

  test('cancellation leaves membership unchanged and performs no operation', async () => {
    const f = fixture();
    expect(await detachSessionFromRun({ session: f.anchor, runKey: f.run.key, confirmed: false }, f.io)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.stored.get(f.anchor.id)).toBe(f.anchor);
  });

  test('confirmed removal retains work and does not restore membership from a legacy-looking title', async () => {
    const f = fixture();
    await detachSessionFromRun({ session: f.anchor, runKey: f.run.key, confirmed: true }, f.io);
    const detached = f.stored.get(f.anchor.id);
    if (!detached) throw new Error('Removed conversation');
    expect(getMultiRunIdentity(detached)).toBeNull();
    expect(detached.directory).toBe(f.anchor.directory);
    expect(detached.title).toBe(f.anchor.title);
    expect(detached.metadata?.openchamber).toEqual({ artifacts: ['report.md'], multirunDetached: true });
    expect(f.stored.get(f.sibling.id)).toBe(f.sibling);
    expect(f.calls).toEqual(['read:a', 'write:a', 'publish:a']);
  });

  test('removes a title-only worktree member in its owning legacy project scope', async () => {
    const f = fixture();
    const legacy = { ...f.anchor, directory: '/repo/worktree', metadata: { external: 'keep' } };
    f.stored.set(legacy.id, legacy);
    const identity = getMultiRunIdentity(legacy, '/repo');
    if (!identity) throw new Error('Legacy membership premise missing');
    await detachSessionFromRun({ session: legacy, runKey: identity.key, legacyDirectory: '/repo', confirmed: true }, f.io);
    expect(getMultiRunIdentity(f.stored.get(legacy.id)!, '/repo')).toBeNull();
    expect(f.stored.get(legacy.id)?.title).toBe(legacy.title);
    expect(f.stored.get(legacy.id)?.metadata?.external).toBe('keep');
  });

  test('failed writes do not publish or replace membership', async () => {
    const f = fixture();
    f.fail();
    await expect(detachSessionFromRun({ session: f.anchor, runKey: f.run.key, confirmed: true }, f.io)).rejects.toThrow('test failure');
    expect(f.stored.get(f.anchor.id)).toBe(f.anchor);
    expect(f.calls).not.toContain('publish:a');
  });

  test('revalidates the current group before removal', async () => {
    const f = fixture();
    f.stored.set(f.anchor.id, session('a'));
    await expect(detachSessionFromRun({ session: f.anchor, runKey: f.run.key, confirmed: true }, f.io)).rejects.toThrow('membership changed');
    expect(f.calls).toEqual(['read:a']);
  });

  for (const change of ['archived', 'child', 'other-project', 'other-run', 'no-model', 'future-marker', 'detached-future-marker'] as const) {
    test(`refuses importing ${change} without altering the target`, async () => {
      const f = fixture();
      let invalid = { ...f.imported };
      if (change === 'archived') invalid.time = { ...invalid.time, archived: 10 };
      if (change === 'child') invalid.parentID = 'parent';
      if (change === 'other-project') invalid.directory = '/other/c';
      if (change === 'no-model') invalid.model = undefined;
      if (change === 'future-marker') invalid.metadata = { openchamber: { multirun: { version: 99 } } };
      if (change === 'detached-future-marker') invalid.metadata = { openchamber: { multirun: { version: 99 }, multirunDetached: true } };
      if (change === 'other-run') invalid = { ...invalid, metadata: withMultiRunMembership({}, {
        version: 1, sessionID: invalid.id, group: { kind: 'id', id: '5fdf22b1-d21e-4324-b2df-01747396c704' },
        groupSlug: 'other', providerID: 'provider', modelID: 'model', role: 'run',
      }) };
      f.stored.set(invalid.id, invalid);
      await expect(attachSessionToRun({ run: f.run, anchor: f.anchor, session: invalid }, f.io)).rejects.toThrow();
      expect(f.calls.filter((call) => call.startsWith('write:'))).toEqual([]);
      expect(f.stored.get(f.anchor.id)).toBe(f.anchor);
    });
  }

  test('generated cancellation sequences cannot remove or mutate any member', async () => {
    const f = fixture();
    const before = JSON.stringify([...f.stored]);
    // Oracle: cancellation is the identity transition for every member. The
    // generated targets alternate between run members and an unrelated chat.
    const targets = [f.anchor, f.sibling, f.imported];
    let seed = 0x51f15e;
    for (let index = 0; index < 2_000; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      await detachSessionFromRun({ session: targets[seed % targets.length], runKey: f.run.key, confirmed: false }, f.io);
    }
    expect(f.calls).toEqual([]);
    expect(JSON.stringify([...f.stored])).toBe(before);
  });
});
