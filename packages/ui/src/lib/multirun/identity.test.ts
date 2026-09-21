import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { getMultiRunIdentity, isFusionSource, sameMultiRunIdentity, withMultiRunMembership, type MultiRunMembership } from './identity';
import { getMultiRunSessionTitle, getFusionSessionTitle, parseMultiRunSessionTitle } from './title';
import { buildAgentGroups } from './groups';

const group = { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' } as const;
const membership = (id: string): MultiRunMembership => ({
  version: 1, sessionID: id, group, groupSlug: 'bench', role: 'run', runGroup: 'g1',
  providerID: 'openrouter', modelID: 'vendor/model',
});
const session = (id: string, marker: MultiRunMembership | null = membership(id)): Session => {
  const result: Session = { id, slug: id, projectID: 'project', directory: '/repo', title: 'bench/openrouter/vendor/model',
    version: '1', time: { created: 1, updated: 1 } };
  if (marker) result.metadata = withMultiRunMembership({}, marker);
  return result;
};

describe('multi-run identity', () => {
  test('renaming, archiving, serialization and model slashes do not change membership', () => {
    const original = session('s1');
    const renamed = { ...original, title: 'any title', time: { ...original.time, archived: 5 } };
    expect(getMultiRunIdentity(renamed)).toEqual(getMultiRunIdentity(original));
    expect(getMultiRunIdentity(JSON.parse(JSON.stringify(renamed)))).toEqual(getMultiRunIdentity(original));
    for (const modelID of ['vendor/2', 'vendor/fusion', 'a/b/c', 'vendor/model%2Fname']) {
      const current = session('s1', { ...membership('s1'), modelID });
      expect(getMultiRunIdentity(current)?.modelID).toBe(modelID);
      expect(getMultiRunIdentity(current)?.role).toBe('run');
    }
  });

  test('pending, invalid, future and forked markers never fall back to a convincing title', () => {
    const original = session('s1');
    expect(getMultiRunIdentity({ ...original, id: 'fork' })).toBeNull();
    expect(getMultiRunIdentity(session('s1', { ...membership('s1'), sessionID: null }))).toBeNull();
    for (const marker of [null, {}, { ...membership('s1'), version: 2 }, { ...membership('s1'), group: { kind: 'id', id: '../other' } }]) {
      expect(getMultiRunIdentity({ ...original, metadata: { openchamber: { multirun: marker } } })).toBeNull();
    }
  });

  test('keeps separate launches and prompt groups out of fusion, including prior fusion results', () => {
    const anchor = getMultiRunIdentity(session('s1'))!;
    const sibling = session('s2');
    const otherLaunch = session('s3', { ...membership('s3'), group: { kind: 'id', id: '5fdf22b1-d21e-4324-b2df-01747396c704' } });
    const otherPrompt = session('s4', { ...membership('s4'), runGroup: 'g2' });
    const fusion = session('f1', { ...membership('f1'), role: 'fusion' });
    const legacy = session('old', null);
    const sources = [sibling, otherLaunch, otherPrompt, fusion, legacy, { ...sibling, id: 'fork' }]
      .filter((candidate) => isFusionSource(anchor, getMultiRunIdentity(candidate)));
    expect(sources.map((item) => item.id)).toEqual(['s2']);
    expect(isFusionSource(getMultiRunIdentity(fusion)!, getMultiRunIdentity(sibling))).toBe(true);
    const groups = buildAgentGroups([session('s1'), sibling, otherLaunch, fusion], new Map(), '/repo');
    expect(groups).toHaveLength(2);
    expect(groups.map((item) => item.sessionCount).sort()).toEqual([1, 3]);
    expect(groups[0].name).toBe(groups[1].name);
    expect(groups[0].id).not.toBe(groups[1].id);
  });

  test('legacy slash IDs, groups, duplicate indices and fusion share one parser', () => {
    for (const runGroup of [undefined, 'g2']) {
      for (const index of [undefined, 2]) {
        const input = { groupSlug: 'bench', runGroup, providerID: 'openrouter', modelID: 'vendor/model', index };
        expect(parseMultiRunSessionTitle(getMultiRunSessionTitle(input))).toEqual({ ...input, fusion: false });
      }
      expect(parseMultiRunSessionTitle(getFusionSessionTitle('bench', 'openrouter', 'vendor/model', runGroup)))
        .toMatchObject({ modelID: 'vendor/model', runGroup, fusion: true });
    }
    expect(parseMultiRunSessionTitle('bench//openrouter/vendor/model/2')).toMatchObject({ modelID: 'vendor/model', index: 2 });
    expect(parseMultiRunSessionTitle('bench/openrouter/vendor/2')).toMatchObject({ modelID: 'vendor', index: 2 });
    expect(parseMultiRunSessionTitle('bench/openrouter/vendor/fusion')).toMatchObject({ modelID: 'vendor', fusion: true });
    for (const title of ['bench/openrouter//model', 'bench/openrouter/model/0', 'bad name/openrouter/vendor/model']) {
      expect(parseMultiRunSessionTitle(title)).toBeNull();
    }
  });

  test('a new fusion over legacy sources retains their scope without promoting those sources', () => {
    const old = session('old', null);
    const anchor = getMultiRunIdentity(old)!;
    const fusion = session('fusion', { ...membership('fusion'), group: anchor.group, runGroup: undefined, role: 'fusion' });
    expect(isFusionSource(getMultiRunIdentity(fusion)!, anchor)).toBe(true);
    expect(isFusionSource(getMultiRunIdentity(fusion)!, getMultiRunIdentity(old, '/different-project'))).toBe(false);
    expect(old.metadata).toBeUndefined();
    for (const kind of ['btw', 'review']) {
      expect(getMultiRunIdentity({ ...old, metadata: { openchamber: { kind } } })).toBeNull();
    }
  });

  test('preserves unrelated metadata and invalidates row memoization only for relevant changes', () => {
    const original = session('s1');
    const changed = session('s1', { ...membership('s1'), role: 'fusion' });
    expect(sameMultiRunIdentity(original, changed)).toBe(false);
    expect(sameMultiRunIdentity(original, { ...original, metadata: { ...original.metadata, extra: true } })).toBe(true);
    expect(sameMultiRunIdentity(original, { ...original, id: 'fork' })).toBe(false);
    const metadata = withMultiRunMembership({ metadata: { other: 1, openchamber: { goal: { status: 'active' } } } }, membership('s1'));
    expect(metadata.other).toBe(1);
    expect(metadata.openchamber).toMatchObject({ goal: { status: 'active' } });
  });
});
