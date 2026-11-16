import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { resolveAdmittedLineageDirectory } from './session-admission-rule';

const session = (id: string, directory: string, parentID?: string): Session => ({
  id,
  parentID,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

describe('resolveAdmittedLineageDirectory', () => {
  const records = new Map([
    ['root', session('root', '/repo')],
    ['worker', session('worker', '/removed/worktree', 'root')],
    ['nested', session('nested', '/elsewhere', 'worker')],
    ['outside', session('outside', '/elsewhere')],
  ]);
  const isAdmitted = (directory: string | null) => directory === '/repo';

  test("reads a session in an admitted folder through its own", () => {
    expect(resolveAdmittedLineageDirectory('root', records, isAdmitted)).toBe('/repo');
  });

  test("reads a subsession in an unknown folder through its nearest admitted ancestor's", () => {
    expect(resolveAdmittedLineageDirectory('worker', records, isAdmitted)).toBe('/repo');
    expect(resolveAdmittedLineageDirectory('nested', records, isAdmitted)).toBe('/repo');
  });

  test('admits nothing for a root session or an unknown one', () => {
    expect(resolveAdmittedLineageDirectory('outside', records, isAdmitted)).toBeNull();
    expect(resolveAdmittedLineageDirectory('missing', records, isAdmitted)).toBeNull();
  });
});
