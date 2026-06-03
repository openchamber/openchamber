import { describe, expect, test } from 'bun:test';
import { toCreatePayload } from '@/lib/worktrees/worktreeManager';
import { useConfigStore } from '@/stores/useConfigStore';

const withSiblingsSetting = <T>(enabled: boolean, run: () => T): T => {
  const original = useConfigStore.getState().settingsWorktreeSiblingsEnabled;
  useConfigStore.setState({ settingsWorktreeSiblingsEnabled: enabled });
  try {
    return run();
  } finally {
    useConfigStore.setState({ settingsWorktreeSiblingsEnabled: original });
  }
};

describe('toCreatePayload — siblingWorktree defaulting (D1=A)', () => {
  test('defaults siblingWorktree from the store setting when no explicit arg', () => {
    const payload = withSiblingsSetting(true, () => toCreatePayload({ worktreeName: 'feat-1234' }, '/repo'));
    expect(payload.siblingWorktree).toBe(true);
  });

  test('omits siblingWorktree when the store setting is false and no explicit arg', () => {
    const payload = withSiblingsSetting(false, () => toCreatePayload({ worktreeName: 'feat-1234' }, '/repo'));
    expect('siblingWorktree' in payload).toBe(false);
  });

  test('explicit args.siblingWorktree:false overrides a true store setting (?? semantics)', () => {
    const payload = withSiblingsSetting(true, () =>
      toCreatePayload({ worktreeName: 'feat-1234', siblingWorktree: false }, '/repo'),
    );
    expect('siblingWorktree' in payload).toBe(false);
  });
});

describe('toCreatePayload — branchName slug seed (D2)', () => {
  test('a branch-only caller seeds the worktree name from the branch slug', () => {
    const payload = toCreatePayload({ branchName: 'feat/1234' }, '/repo');
    expect(payload.worktreeName).toBe('feat-1234');
  });
});
