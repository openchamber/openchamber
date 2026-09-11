import { describe, expect, test } from 'bun:test';

import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { resolveProjectContextOwner } from './useProjectContextOwner';

const projects = [
  { id: 'openchamber', path: '/workspace/openchamber', label: 'OpenChamber' },
];

describe('resolveProjectContextOwner', () => {
  test('resolves a managed chat directory to the Chats root instead of the active project', () => {
    const owner = resolveProjectContextOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '/Users/test/.config/openchamber/chats/2026-08-27/session-a',
      activeProjectId: 'openchamber',
      chatDraftOpen: false,
      chatDraftTarget: 'project',
      homeDirectory: '/Users/test',
    });

    expect(owner).toEqual({
      id: CHAT_DRAFT_PROJECT_ID,
      path: '/Users/test/.config/openchamber/chats',
    });
  });

  test('resolves a worktree session to its owning project', () => {
    const owner = resolveProjectContextOwner({
      projects,
      worktreesByProject: new Map([
        ['/workspace/openchamber', [{
          path: '/workspace/openchamber-feature',
          projectDirectory: '/workspace/openchamber',
          branch: 'feature',
          label: 'feature',
        }]],
      ]),
      directory: '/workspace/openchamber-feature',
      activeProjectId: null,
      chatDraftOpen: false,
      chatDraftTarget: 'project',
      homeDirectory: '/Users/test',
    });

    expect(owner).toEqual({ id: 'openchamber', path: '/workspace/openchamber' });
  });

  test('returns null for a recognized directory that owns nothing, instead of borrowing the active project', () => {
    const owner = resolveProjectContextOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '/some/other/project',
      activeProjectId: 'openchamber',
      chatDraftOpen: false,
      chatDraftTarget: 'project',
      homeDirectory: '/Users/test',
    });

    expect(owner).toBeNull();
  });

  test('falls back to the active project only when there is no directory at all', () => {
    const owner = resolveProjectContextOwner({
      projects,
      worktreesByProject: new Map(),
      directory: null,
      activeProjectId: 'openchamber',
      chatDraftOpen: false,
      chatDraftTarget: 'project',
      homeDirectory: '/Users/test',
    });

    expect(owner).toEqual({ id: 'openchamber', path: '/workspace/openchamber' });
  });

  test('never falls back to the first project when the active project is unknown', () => {
    const owner = resolveProjectContextOwner({
      projects,
      worktreesByProject: new Map(),
      directory: null,
      activeProjectId: 'missing-project',
      chatDraftOpen: false,
      chatDraftTarget: 'project',
      homeDirectory: '/Users/test',
    });

    expect(owner).toBeNull();
  });
});
