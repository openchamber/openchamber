import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import {
  indexSessionTreeChildren,
  resolveBulkDestructiveSessionIds,
  resolveSelectionFolderScopes,
} from './useSidebarBulkActions';

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('sidebar bulk project scopes', () => {
  test('uses every root and worktree scope owned by the selected project', () => {
    const scopes = resolveSelectionFolderScopes('project-a', (projectId) => projectId === 'project-a'
      ? [
        { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
        { scopeKey: '/workspace/project-a-worktree', directory: '/workspace/project-a-worktree' },
      ]
      : []);

    expect(scopes).toEqual(['/workspace/project-a', '/workspace/project-a-worktree']);
  });

  test('keeps a directory scope when no project scope owns it', () => {
    expect(resolveSelectionFolderScopes('/workspace/vscode', () => [])).toEqual(['/workspace/vscode']);
  });
});

describe('sidebar bulk destructive scope', () => {
  test('includes descendants in the action and confirmation scope', () => {
    const descendants = new Map([
      ['archived-parent', ['live-child', 'archived-child']],
      ['live-child', ['grandchild']],
      ['other', ['live-child']],
    ]);

    expect(resolveBulkDestructiveSessionIds(
      ['archived-parent', 'other'],
      (sessionId) => descendants.get(sessionId) ?? [],
    )).toEqual(['archived-parent', 'live-child', 'grandchild', 'archived-child', 'other']);
  });

  test('follows the grouped tree without crossing detached or project roots', () => {
    const node = (id: string, children: SessionNode[] = []): SessionNode => ({
      session: session(id),
      children,
      worktree: null,
    });
    const projectRoot = node('project-root', [node('nested-child')]);
    const detachedArchivedChild = node('detached-archived-child');
    const otherProjectChild = node('other-project-child');

    const children = indexSessionTreeChildren([
      projectRoot,
      detachedArchivedChild,
      otherProjectChild,
    ]);

    expect(children.get('project-root')).toEqual(['nested-child']);
    expect(children.get('detached-archived-child')).toEqual([]);
    expect(children.get('other-project-child')).toEqual([]);
  });
});
