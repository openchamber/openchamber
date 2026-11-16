import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { findRunningOperatorChildren } from './operator-children-done';

const session = (id: string, parentID?: string, operator = true): Session => {
  const record: Session = {
    id,
    projectID: 'proj_1',
    title: id,
    directory: '/repo',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  if (parentID) record.parentID = parentID;
  if (parentID && operator) record.metadata = { openchamber: { kind: 'operator-child', parentID } };
  return record;
};

describe('running operator children', () => {
  const sessions = [
    session('ses_root'),
    session('ses_worker', 'ses_root'),
    session('ses_idle_worker', 'ses_root'),
    session('ses_grandchild', 'ses_idle_worker'),
    session('ses_subagent', 'ses_root', false),
    session('ses_subagent_of_worker', 'ses_idle_worker', false),
    session('ses_other_root'),
    session('ses_other_worker', 'ses_other_root'),
  ];

  test('finds the running ones under the roots, at any depth, and only operator children', () => {
    const active = new Set(['ses_worker', 'ses_grandchild', 'ses_subagent', 'ses_other_worker']);
    expect(findRunningOperatorChildren(['ses_root'], sessions, active).map((entry) => entry.id).sort()).toEqual(['ses_grandchild', 'ses_idle_worker', 'ses_worker']);
  });

  test('a child whose own subagent runs counts as running', () => {
    const active = new Set(['ses_subagent_of_worker']);
    expect(findRunningOperatorChildren(['ses_root'], sessions, active).map((entry) => entry.id)).toEqual(['ses_idle_worker']);
  });

  test('nothing to ask about when every child is idle', () => {
    expect(findRunningOperatorChildren(['ses_root'], sessions, new Set(['ses_subagent']))).toEqual([]);
  });
});
