import { describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

describe('gitCommitDiffWidth', () => {
  test('setGitCommitDiffWidth clamps to supported bounds', () => {
    useUIStore.getState().setGitCommitDiffWidth(100);
    expect(useUIStore.getState().gitCommitDiffWidth).toBe(320);

    useUIStore.getState().setGitCommitDiffWidth(420);
    expect(useUIStore.getState().gitCommitDiffWidth).toBe(420);

    useUIStore.getState().setGitCommitDiffWidth(99999);
    expect(useUIStore.getState().gitCommitDiffWidth).toBe(900);
  });

  test('setGitCommitDiffWidth ignores non-finite values', () => {
    useUIStore.getState().setGitCommitDiffWidth(500);
    useUIStore.getState().setGitCommitDiffWidth(Number.NaN);
    expect(useUIStore.getState().gitCommitDiffWidth).toBe(500);
  });
});
