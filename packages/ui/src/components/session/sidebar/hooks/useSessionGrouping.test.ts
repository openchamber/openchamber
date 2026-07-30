import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { ARCHIVED_GROUP_KEY, resolveSessionGroupKey } from './useSessionGrouping';

const PROJECT_ROOT = '/repo/app';
const WORKTREE = '/repo/app-feature';

type Context = Parameters<typeof resolveSessionGroupKey>[1];

const context = (overrides: Partial<Context> = {}): Context => ({
  rootKey: PROJECT_ROOT,
  normalizedProjectRoot: PROJECT_ROOT,
  worktreesByPath: new Map([[WORKTREE, {}]]),
  worktreeMetadataBySessionId: new Map<string, WorktreeMetadata>(),
  isVSCode: false,
  ...overrides,
});

const session = (id: string, directory: string | null, archived?: number): Session => ({
  id,
  directory,
  ...(archived === undefined ? {} : { time: { archived } }),
}) as Session;

describe('resolveSessionGroupKey', () => {
  test('groups a live session in the project root under the root key', () => {
    expect(resolveSessionGroupKey(session('a', PROJECT_ROOT), context())).toBe(PROJECT_ROOT);
  });

  test('groups a live session in a registered worktree under that worktree', () => {
    expect(resolveSessionGroupKey(session('a', WORKTREE), context())).toBe(WORKTREE);
  });

  test('keeps a live session out of the archived bucket when its worktree is gone', () => {
    expect(resolveSessionGroupKey(session('a', '/repo/app-removed'), context())).toBe(PROJECT_ROOT);
  });

  test('keeps a live session in a project subdirectory out of the archived bucket', () => {
    expect(resolveSessionGroupKey(session('a', `${PROJECT_ROOT}/packages/ui`), context())).toBe(PROJECT_ROOT);
  });

  test('keeps a live session without directory metadata out of the archived bucket', () => {
    expect(resolveSessionGroupKey(session('a', null), context())).toBe(PROJECT_ROOT);
  });

  test('falls back to the placeholder root key when the project root is unknown', () => {
    const unknownRoot = context({ rootKey: '__project_root__', normalizedProjectRoot: null });
    expect(resolveSessionGroupKey(session('a', '/elsewhere'), unknownRoot)).toBe('__project_root__');
  });

  test('prefers per-session worktree metadata over the session directory', () => {
    const withMetadata = context({
      worktreeMetadataBySessionId: new Map([['a', { path: WORKTREE } as WorktreeMetadata]]),
    });
    expect(resolveSessionGroupKey(session('a', PROJECT_ROOT), withMetadata)).toBe(WORKTREE);
  });

  test('groups archived sessions into the archived bucket regardless of directory', () => {
    expect(resolveSessionGroupKey(session('a', PROJECT_ROOT, 10), context())).toBe(ARCHIVED_GROUP_KEY);
    expect(resolveSessionGroupKey(session('b', WORKTREE, 10), context())).toBe(ARCHIVED_GROUP_KEY);
    expect(resolveSessionGroupKey(session('c', null, 10), context())).toBe(ARCHIVED_GROUP_KEY);
  });

  test('groups every live VS Code session under its workspace root', () => {
    const vscode = context({ isVSCode: true });
    expect(resolveSessionGroupKey(session('a', WORKTREE), vscode)).toBe(PROJECT_ROOT);
    expect(resolveSessionGroupKey(session('b', PROJECT_ROOT, 10), vscode)).toBe(ARCHIVED_GROUP_KEY);
  });
});
