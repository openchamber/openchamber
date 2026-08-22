import { describe, expect, test } from 'bun:test';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';

const { getDiffTabRenderKind } = await import('./contextPanelDiffTabs');

type DiffTabRenderInput = Parameters<typeof getDiffTabRenderKind>[0];
type HasExactCommitTargetContract =
  [DiffTabRenderInput] extends [{ commitDiffTarget: GitCommitDiffTarget | null }]
    ? ([{ commitDiffTarget: GitCommitDiffTarget | null }] extends [DiffTabRenderInput] ? true : false)
    : false;
const hasExactCommitTargetContract: HasExactCommitTargetContract = true;

const buildTarget = (): GitCommitDiffTarget => ({
  commitHash: 'a'.repeat(40),
  parentHash: 'b'.repeat(40),
  file: {
    path: 'src/history.ts',
    originalPath: 'src/history-before.ts',
    status: 'R',
    kind: 'file',
    objectId: '1'.repeat(40),
    originalObjectId: '2'.repeat(40),
    insertions: 4,
    deletions: 2,
    isBinary: false,
  },
});

describe('ContextPanel diff render kind', () => {
  test('routes historical diff tabs to the historical preview and ordinary diff tabs to DiffView', () => {
    const commitTab: DiffTabRenderInput = { commitDiffTarget: buildTarget() };
    const workingTab: DiffTabRenderInput = { commitDiffTarget: null };

    expect(hasExactCommitTargetContract).toBe(true);
    expect(getDiffTabRenderKind(commitTab)).toBe('commit');
    expect(getDiffTabRenderKind(workingTab)).toBe('working');
  });
});
