import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { withMultiRunMembership, type MultiRunMembership } from './identity';
import { buildMultiRunIndex, multiRunVariantLabel } from './runs';

const groupId = '9f512893-6e63-4e49-a534-5de733ca103e';
const membership = (id: string, overrides: Partial<MultiRunMembership> = {}): MultiRunMembership => ({
  version: 1, sessionID: id, group: { kind: 'id', id: groupId }, groupSlug: 'fix-auth', role: 'run',
  providerID: 'anthropic', modelID: 'claude', ...overrides,
});
const session = (id: string, marker: MultiRunMembership | null, extra: Partial<Session> = {}): Session => {
  const result: Session = {
    id, projectID: 'project', directory: `/worktrees/${id}`, title: id,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Number(id.replace(/\D/g, '')) || 1, updated: 1 },
    ...extra,
  };
  if (marker) result.metadata = withMultiRunMembership({}, marker);
  return result;
};
const scope = () => '/repo';

describe('buildMultiRunIndex', () => {
  test('groups members by launch, orders variants then creation, fusions first', () => {
    const index = buildMultiRunIndex([
      session('s3', membership('s3', { runGroup: 'g2', title: 'Fix auth refresh' })),
      session('s1', membership('s1', { runGroup: 'g1' })),
      session('s2', membership('s2', { runGroup: 'g1', providerID: 'openai', modelID: 'gpt' })),
      session('f9', membership('f9', { role: 'fusion' })),
      session('solo', null),
    ], scope);
    expect(index.runs.size).toBe(1);
    const run = [...index.runs.values()][0];
    expect(run.title).toBe('Fix auth refresh');
    expect(run.lanes.map((lane) => lane.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(run.fusions.map((fusion) => fusion.sessionId)).toEqual(['f9']);
    expect(run.memberIds).toEqual(['f9', 's1', 's2', 's3']);
    expect(run.providerIDs).toEqual(['anthropic', 'openai']);
    expect(run.variants).toEqual(['g1', 'g2']);
    expect(index.runKeyBySessionId.get('s2')).toBe(run.key);
    expect(index.runKeyBySessionId.has('solo')).toBe(false);
  });

  test('a single active member is an ordinary session again (after Keep)', () => {
    const index = buildMultiRunIndex([
      session('s1', membership('s1')),
      session('s2', membership('s2'), { time: { created: 2, updated: 2, archived: 5 } }),
    ], scope);
    expect(index.runs.size).toBe(0);
    expect(index.runKeyBySessionId.size).toBe(0);
  });

  test('forked copies and subagent children never join', () => {
    const original = session('s1', membership('s1'));
    const index = buildMultiRunIndex([
      original,
      { ...original, id: 'fork' },
      session('s2', membership('s2'), { parentID: 's1' }),
    ], scope);
    expect(index.runs.size).toBe(0);
  });

  test('title falls back to the slug for runs launched before titles existed', () => {
    const index = buildMultiRunIndex([session('s1', membership('s1')), session('s2', membership('s2'))], scope);
    expect([...index.runs.values()][0]?.title).toBe('fix-auth');
  });
});

test('variant labels', () => {
  expect(multiRunVariantLabel(undefined)).toBe('A');
  expect(multiRunVariantLabel('g1')).toBe('A');
  expect(multiRunVariantLabel('g2')).toBe('B');
});
