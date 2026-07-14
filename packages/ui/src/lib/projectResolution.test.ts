import { describe, expect, test } from 'bun:test';

import { resolveProjectForSessionDirectory } from './projectResolution';

describe('resolveProjectForSessionDirectory', () => {
  test('prefers nested project over containing worktree project', () => {
    const backend = { id: 'backend', path: '/projects/backend' };
    const api = { id: 'api', path: '/projects/backend/et.api3' };
    const worktrees = new Map([[
      backend.path,
      [{
        path: api.path,
        projectDirectory: backend.path,
        branch: 'et-api3',
        label: 'et.api3',
      }],
    ]]);

    expect(resolveProjectForSessionDirectory([backend, api], worktrees, api.path)).toBe(api);
  });

  test('prefers external worktree over containing unrelated project', () => {
    const app = { id: 'app', path: '/projects/app' };
    const worktreesProject = { id: 'worktrees', path: '/worktrees' };
    const worktreePath = '/worktrees/app-feature';
    const worktrees = new Map([[
      app.path,
      [{
        path: worktreePath,
        projectDirectory: app.path,
        branch: 'feature',
        label: 'feature',
      }],
    ]]);

    expect(resolveProjectForSessionDirectory([app, worktreesProject], worktrees, `${worktreePath}/src`)).toBe(app);
  });
});
