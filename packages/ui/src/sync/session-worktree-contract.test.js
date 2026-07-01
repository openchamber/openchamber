import { describe, expect, test } from 'bun:test';
import {
  buildAttachmentFromCanonicalization,
  getAttachedSessionDirectory,
  resolveSessionWorktreeState,
  formatSessionWorktreeBadge,
  getSessionWorktreeRepairActions,
  getMutationBlockingReasons,
  isWithinWorktreeRoot,
  buildSessionTargetOptions,
} from './session-worktree-contract';

describe('isWithinWorktreeRoot', () => {
  test('returns true when candidate equals root', () => {
    expect(isWithinWorktreeRoot('/repo/worktrees/feat-a', '/repo/worktrees/feat-a')).toBe(true);
  });

  test('returns true when candidate is a subdirectory of root', () => {
    expect(isWithinWorktreeRoot('/repo/worktrees/feat-a/src', '/repo/worktrees/feat-a')).toBe(true);
  });

  test('returns false when candidate is outside root', () => {
    expect(isWithinWorktreeRoot('/tmp/outside', '/repo/worktrees/feat-a')).toBe(false);
  });

  test('returns false when either is null/empty', () => {
    expect(isWithinWorktreeRoot(null, '/repo')).toBe(false);
    expect(isWithinWorktreeRoot('/repo', null)).toBe(false);
    expect(isWithinWorktreeRoot('', '/repo')).toBe(false);
  });
});

describe('getAttachedSessionDirectory', () => {
  test('prefers canonical cwd when attachment is healthy', () => {
    expect(getAttachedSessionDirectory({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    }, '/repo')).toBe('/repo/worktrees/feat-a/src');
  });

  test('falls back to worktree root when attachment is degraded', () => {
    expect(getAttachedSessionDirectory({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true,
    }, '/repo')).toBe('/repo/worktrees/feat-a');
  });

  test('uses fallback when no attachment exists', () => {
    expect(getAttachedSessionDirectory(null, '/repo')).toBe('/repo');
  });
});

describe('buildAttachmentFromCanonicalization', () => {
  test('builds a canonical attachment for a healthy current-worktree session', () => {
    const result = buildAttachmentFromCanonicalization({
      worktreeRoot: '/repo',
      cwd: '/repo/src',
      branch: 'main',
      headState: 'branch',
      worktreeStatus: 'ready',
      legacy: false,
      degraded: false,
    }, {
      fallbackDirectory: '/repo/src',
    });

    expect(result.worktreeRoot).toBe('/repo');
    expect(result.cwd).toBe('/repo/src');
    expect(result.branch).toBe('main');
    expect(result.legacy).toBe(false);
  });

  test('preserves worktreeSource while recovering a legacy session', () => {
    const result = buildAttachmentFromCanonicalization({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      legacy: false,
      degraded: false,
    }, {
      existingAttachment: {
        worktreeRoot: null,
        cwd: '/repo/worktrees/feat-a',
        branch: null,
        headState: 'detached',
        worktreeStatus: 'invalid',
        worktreeSource: 'created-for-session',
        legacy: true,
        degraded: true,
      },
      fallbackDirectory: '/repo/worktrees/feat-a',
    });

    expect(result.worktreeSource).toBe('created-for-session');
    expect(result.legacy).toBe(false);
  });

  test('uses worktree root as cwd when canonicalization is degraded', () => {
    const result = buildAttachmentFromCanonicalization({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      legacy: true,
      degraded: true,
    }, {
      fallbackDirectory: '/repo/worktrees/feat-a',
    });

    expect(result.cwd).toBe('/repo/worktrees/feat-a');
    expect(result.degraded).toBe(true);
  });
});

describe('resolveSessionWorktreeState', () => {
  test('keeps cwd when inside worktreeRoot', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/feat-a/src',
      metadata: {
        path: '/repo/worktrees/feat-a',
        projectDirectory: '/repo',
        branch: 'feat-a',
        label: 'feat-a',
        worktreeRoot: '/repo/worktrees/feat-a',
        worktreeStatus: 'ready',
        headState: 'branch',
      },
      cwdExists: true,
    });

    expect(result.cwd).toBe('/repo/worktrees/feat-a/src');
    expect(result.worktreeRoot).toBe('/repo/worktrees/feat-a');
    expect(result.degraded).toBe(false);
    expect(result.worktreeStatus).toBe('ready');
    expect(result.headState).toBe('branch');
  });

  test('falls back to worktreeRoot when cwd is invalid', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/tmp/outside',
      metadata: {
        path: '/repo/worktrees/feat-a',
        projectDirectory: '/repo',
        branch: 'feat-a',
        label: 'feat-a',
        worktreeRoot: '/repo/worktrees/feat-a',
        worktreeStatus: 'ready',
        headState: 'branch',
      },
      cwdExists: false,
    });

    expect(result.cwd).toBe('/repo/worktrees/feat-a');
    expect(result.degraded).toBe(true);
  });

  test('falls back to worktreeRoot when cwd escapes root', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/feat-a/src',
      metadata: {
        path: '/repo/worktrees/feat-a',
        projectDirectory: '/repo',
        branch: 'feat-a',
        label: 'feat-a',
        worktreeRoot: '/repo/worktrees/feat-a',
        worktreeStatus: 'ready',
        headState: 'branch',
      },
      cwdExists: true,
    });

    // cwd is inside worktreeRoot so should be kept
    expect(result.cwd).toBe('/repo/worktrees/feat-a/src');
    expect(result.degraded).toBe(false);
  });

  test('marks missing metadata as legacy with invalid status', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo',
      metadata: null,
      cwdExists: true,
    });

    expect(result.legacy).toBe(true);
    expect(result.worktreeStatus).toBe('invalid');
    expect(result.degraded).toBe(true);
  });

  test('preserves unborn head state', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/new-branch',
      metadata: {
        path: '/repo/worktrees/new-branch',
        projectDirectory: '/repo',
        branch: '',
        label: 'new-branch',
        worktreeRoot: '/repo/worktrees/new-branch',
        worktreeStatus: 'ready',
        headState: 'unborn',
      },
      cwdExists: true,
    });

    expect(result.headState).toBe('unborn');
  });

  test('recovers legacy session when runtime canonicalization resolves a worktree', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/feat-a/src',
      metadata: null,
      cwdExists: true,
      runtimeResolution: {
        worktreeRoot: '/repo/worktrees/feat-a',
        cwd: '/repo/worktrees/feat-a/src',
        branch: 'feat-a',
        headState: 'branch',
        worktreeStatus: 'ready',
        worktreeSource: 'existing',
        legacy: false,
        degraded: false,
      },
    });

    expect(result.legacy).toBe(false);
    expect(result.worktreeRoot).toBe('/repo/worktrees/feat-a');
    expect(result.worktreeSource).toBe('existing');
    expect(result.degraded).toBe(false);
  });

  test('defaults detached when branch is empty but headState not specified', () => {
    const result = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/detached',
      metadata: {
        path: '/repo/worktrees/detached',
        projectDirectory: '/repo',
        branch: '',
        label: 'detached',
      },
      cwdExists: true,
    });

    expect(result.headState).toBe('detached');
  });

  test('canonical producer metadata preserves branch/detached/unborn states', () => {
    // branch state
    const branchResult = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/feat-a',
      metadata: {
        path: '/repo/worktrees/feat-a',
        projectDirectory: '/repo',
        branch: 'feat-a',
        label: 'feat-a',
        worktreeRoot: '/repo/worktrees/feat-a',
        worktreeStatus: 'ready',
        headState: 'branch',
        worktreeSource: 'created-for-session',
      },
      cwdExists: true,
    });
    expect(branchResult.headState).toBe('branch');
    expect(branchResult.worktreeStatus).toBe('ready');

    // detached state
    const detachedResult = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/detached',
      metadata: {
        path: '/repo/worktrees/detached',
        projectDirectory: '/repo',
        branch: '',
        label: 'detached',
        worktreeRoot: '/repo/worktrees/detached',
        worktreeStatus: 'ready',
        headState: 'detached',
        worktreeSource: 'existing',
      },
      cwdExists: true,
    });
    expect(detachedResult.headState).toBe('detached');

    // unborn state
    const unbornResult = resolveSessionWorktreeState({
      sessionDirectory: '/repo/worktrees/unborn',
      metadata: {
        path: '/repo/worktrees/unborn',
        projectDirectory: '/repo',
        branch: '',
        label: 'unborn',
        worktreeRoot: '/repo/worktrees/unborn',
        worktreeStatus: 'ready',
        headState: 'unborn',
        worktreeSource: 'created-for-session',
      },
      cwdExists: true,
    });
    expect(unbornResult.headState).toBe('unborn');
  });
});

describe('formatSessionWorktreeBadge', () => {
  test('formats needs-attention badge for invalid worktree', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'invalid',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'detached',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Needs attention');
  });

  test('formats legacy session badge', () => {
    const badge = formatSessionWorktreeBadge({
      legacy: true,
      worktreeStatus: 'invalid',
      degraded: true,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Legacy session');
  });

  test('formats detached HEAD', () => {
    const badge = formatSessionWorktreeBadge({
      headState: 'detached',
      degraded: false,
      legacy: false,
      branch: null,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Detached HEAD');
  });

  test('formats unborn branch', () => {
    const badge = formatSessionWorktreeBadge({
      headState: 'unborn',
      degraded: false,
      legacy: false,
      branch: null,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Unborn branch');
  });

  test('formats current branch name', () => {
    const badge = formatSessionWorktreeBadge({
      branch: 'feature/my-branch',
      headState: 'branch',
      degraded: false,
      legacy: false,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Current branch: feature/my-branch');
  });

  test('formats missing worktree', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'missing',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Worktree missing');
  });

  test('formats needs-attention for in-progress git operation', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'ready',
      attentionReason: 'merge',
      degraded: false,
      legacy: false,
      branch: 'main',
      headState: 'branch',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Needs attention');
  });
});

describe('getSessionWorktreeRepairActions', () => {
  test('returns open-without-worktree-features for missing worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'missing',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(actions).toContain('open-without-worktree-features');
  });

  test('returns open-without-worktree-features for invalid worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'invalid',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(actions).toContain('open-without-worktree-features');
  });

  test('returns empty for ready worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'ready',
      degraded: false,
      legacy: false,
      branch: 'main',
      headState: 'branch',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(actions).toHaveLength(0);
  });
});

describe('buildSessionTargetOptions', () => {
  test('labels root directory and isolated worktrees distinctly', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo/.worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
      ],
    });

    expect(options[0]?.label).toContain('main');
    expect(options[1]?.label).toContain('feat-a');
    expect(options[0]?.kind).toBe('root');
    expect(options[1]?.kind).toBe('worktree');
  });

  test('excludes worktree path that equals projectRoot', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo', branch: 'main', label: 'main', projectDirectory: '/repo' },
        { path: '/repo/worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
      ],
    });

    expect(options).toHaveLength(2); // root + one worktree, not three
  });

  test('handles empty worktrees array', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [],
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.kind).toBe('root');
  });

  test('marks pending bootstrap worktree distinctly', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo/worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
        { path: '/repo/worktrees/feat-b', branch: 'feat-b', label: 'feat-b', projectDirectory: '/repo' },
      ],
      pendingBootstrapDirectory: '/repo/worktrees/feat-b',
    });

    const root = options.find((o) => o.kind === 'root');
    const pending = options.find((o) => o.value === '/repo/worktrees/feat-b');
    const nonPending = options.find((o) => o.value === '/repo/worktrees/feat-a');

    expect(root?.pending).toBeUndefined();
    expect(pending?.pending).toBe(true);
    expect(nonPending?.pending).toBeUndefined();
  });
});

describe('getMutationBlockingReasons', () => {
  test('returns empty when attachment is null', () => {
    expect(getMutationBlockingReasons(null)).toHaveLength(0);
    expect(getMutationBlockingReasons(undefined)).toHaveLength(0);
  });

  test('blocks mutation when worktree is missing', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'missing',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'missing' });
  });

  test('blocks mutation when worktree is invalid', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'invalid' });
  });

  test('blocks mutation during merge attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'merge',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'merge' });
  });

  test('blocks mutation during rebase attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'rebase',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'rebase' });
  });

  test('returns empty for ready worktree with no attention', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });
    expect(reasons).toHaveLength(0);
  });

  test('blocks mutation during cherry-pick attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'cherry-pick',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'cherry-pick' });
  });

  test('blocks mutation when git status is dirty', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: false, files: [{ path: 'a.ts' }, { path: 'b.ts' }] }
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 2 });
  });

  test('blocks mutation for dirty tree even without attachment', () => {
    const reasons = getMutationBlockingReasons(null, { isClean: false, files: [{ path: 'a.ts' }] });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 1 });
  });

  test('does not block when git status is clean', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: true, files: [] }
    );
    expect(reasons).toHaveLength(0);
  });

  test('returns dirty and missing reasons together', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'missing', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: false, files: [{ path: 'a.ts' }] }
    );
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 1 });
    expect(reasons[1]).toEqual({ reason: 'missing' });
  });

  test('returns dirty without file count when files is undefined', () => {
    const reasons = getMutationBlockingReasons(
      null,
      { isClean: false }
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty' });
  });
});
