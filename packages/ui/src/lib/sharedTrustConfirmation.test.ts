import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ProjectSetup } from './openchamberConfig';

const project = { id: 'p', path: '/repo' };

let setup: ProjectSetup;
let patches: Array<Record<string, unknown>> = [];
let saveOk = true;

let readFails = false;

mock.module('./openchamberConfig', () => ({
  getProjectSetup: mock(async () => setup),
  fetchProjectSetup: mock(async () => {
    if (readFails) throw new Error('HTTP 500');
    return setup;
  }),
  updateProjectSetup: mock(async (_project: unknown, patch: Record<string, unknown>) => {
    patches.push(patch);
    return saveOk;
  }),
}));

const {
  ensureSharedSetupTrusted,
  getSharedTrustConfirmationSnapshot,
  resetSharedSetupTrust,
  resolveWorktreeSetupCommands,
  resolveWorktreeSetupCommandsOrCancel,
  resolveWorktreeTeardownCommands,
  settleSharedTrustConfirmation,
} = await import('./sharedTrustConfirmation');

const baseSetup = (): ProjectSetup => ({
  trust: { hash: 'sha256:abc', trusted: false },
  setupWorktree: ['bun install', 'cp .env.example .env'],
  setupWorktreeWait: false,
  teardownWorktree: ['docker compose down', 'rm -f .dev.pid'],
  projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'shared' }],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'ok',
    path: '.openchamber/project.json',
    setupWorktree: ['bun install'],
    setupWorktreeWait: null,
    teardownWorktree: ['docker compose down'],
    projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: ['cp .env.example .env'],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    teardownWorktree: ['rm -f .dev.pid'],
    createWorktreeCommand: '',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
    notesTodosInRepository: false,
  },
});

describe('shared trust confirmation', () => {
  beforeEach(() => {
    setup = baseSetup();
    patches = [];
    saveOk = true;
    readFails = false;
    if (getSharedTrustConfirmationSnapshot()) settleSharedTrustConfirmation('skip');
  });

  test('runs without asking when the current commands were trusted before', async () => {
    setup.trust.trusted = true;
    expect(await ensureSharedSetupTrusted(project, setup)).toBe(true);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
    expect(patches).toEqual([]);
  });

  test('runs without asking when nothing in the shared file executes', async () => {
    setup.trust = { hash: null, trusted: true };
    expect(await ensureSharedSetupTrusted(project, setup)).toBe(true);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('asks with the exact commands and records a trust answer against the hash', async () => {
    const pending = ensureSharedSetupTrusted(project, setup);
    const request = getSharedTrustConfirmationSnapshot();
    expect(request?.sharedPath).toBe('.openchamber/project.json');
    expect(request?.setupCommands).toEqual(['bun install']);
    expect(request?.actions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev' }]);

    settleSharedTrustConfirmation('trust');
    expect(await pending).toBe(true);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
    expect(patches).toEqual([{ sharedTrustHash: 'sha256:abc' }]);
  });

  test('skip runs only the personal commands and records nothing', async () => {
    const pending = resolveWorktreeSetupCommands(project);
    await Promise.resolve();
    expect(getSharedTrustConfirmationSnapshot()?.dismissChoice).toBe('skip');
    settleSharedTrustConfirmation('skip');
    expect(await pending).toEqual(['cp .env.example .env']);
    expect(patches).toEqual([]);
  });

  test('a cancellable worktree request is dismissed as cancelled, not skipped', async () => {
    const pending = resolveWorktreeSetupCommandsOrCancel(project);
    await Promise.resolve();
    const request = getSharedTrustConfirmationSnapshot();
    expect(request?.dismissChoice).toBe('cancel');

    settleSharedTrustConfirmation(request?.dismissChoice ?? 'skip');
    expect(await pending).toBeNull();
    expect(patches).toEqual([]);
  });

  test('a newer request cancels a pending cancellable request', async () => {
    const first = resolveWorktreeSetupCommandsOrCancel(project);
    await Promise.resolve();
    const second = resolveWorktreeSetupCommands(project);

    expect(await first).toBeNull();
    settleSharedTrustConfirmation('skip');
    expect(await second).toEqual(['cp .env.example .env']);
  });

  test('a cancellable request that is trusted runs the full command list', async () => {
    const pending = resolveWorktreeSetupCommandsOrCancel(project);
    await Promise.resolve();
    settleSharedTrustConfirmation('trust');
    expect(await pending).toEqual(['bun install', 'cp .env.example .env']);
    expect(patches).toEqual([{ sharedTrustHash: 'sha256:abc' }]);
  });

  test('trust resolves the full command list; a trusted project never asks', async () => {
    const pending = resolveWorktreeSetupCommands(project);
    await Promise.resolve();
    settleSharedTrustConfirmation('trust');
    expect(await pending).toEqual(['bun install', 'cp .env.example .env']);

    setup.trust.trusted = true;
    expect(await resolveWorktreeSetupCommands(project)).toEqual(['bun install', 'cp .env.example .env']);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('replace mode and a shared file without setup commands never ask', async () => {
    setup.personal.setupWorktreeMode = 'replace';
    setup.setupWorktree = ['cp .env.example .env'];
    expect(await resolveWorktreeSetupCommands(project)).toEqual(['cp .env.example .env']);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();

    setup = baseSetup();
    setup.shared.setupWorktree = [];
    setup.setupWorktree = ['cp .env.example .env'];
    expect(await resolveWorktreeSetupCommands(project)).toEqual(['cp .env.example .env']);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('a newer request settles the pending one as skip', async () => {
    const first = ensureSharedSetupTrusted(project, setup);
    const second = ensureSharedSetupTrusted(project, setup);
    expect(await first).toBe(false);
    settleSharedTrustConfirmation('trust');
    expect(await second).toBe(true);
  });

  test('a failed record still honours the answer this once', async () => {
    saveOk = false;
    const pending = ensureSharedSetupTrusted(project, setup);
    settleSharedTrustConfirmation('trust');
    expect(await pending).toBe(true);
  });

  test('teardown asks with the shared teardown commands; skip or closing runs only the personal ones', async () => {
    const pending = resolveWorktreeTeardownCommands(project);
    await Promise.resolve();
    const request = getSharedTrustConfirmationSnapshot();
    expect(request?.teardownCommands).toEqual(['docker compose down']);
    expect(request?.dismissChoice).toBe('skip');

    settleSharedTrustConfirmation('skip');
    expect(await pending).toEqual(['rm -f .dev.pid']);
    expect(patches).toEqual([]);
  });

  test('teardown runs the shared commands, then the personal ones, once trusted', async () => {
    const pending = resolveWorktreeTeardownCommands(project);
    await Promise.resolve();
    settleSharedTrustConfirmation('trust');
    expect(await pending).toEqual(['docker compose down', 'rm -f .dev.pid']);
    expect(patches).toEqual([{ sharedTrustHash: 'sha256:abc' }]);
  });

  test('two teardowns in one project share one prompt and its answer', async () => {
    const first = resolveWorktreeTeardownCommands(project);
    const second = resolveWorktreeTeardownCommands(project);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSharedTrustConfirmationSnapshot()?.teardownCommands).toEqual(['docker compose down']);

    settleSharedTrustConfirmation('trust');
    expect(await first).toEqual(['docker compose down', 'rm -f .dev.pid']);
    expect(await second).toEqual(['docker compose down', 'rm -f .dev.pid']);
    expect(patches).toEqual([{ sharedTrustHash: 'sha256:abc' }]);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('a later prompt waits for an open teardown prompt, and each gets its own answer', async () => {
    const otherProject = { id: 'other', path: '/other' };
    const teardown = resolveWorktreeTeardownCommands(project);
    await Promise.resolve();
    await Promise.resolve();
    const newSetup = resolveWorktreeSetupCommandsOrCancel(otherProject);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSharedTrustConfirmationSnapshot()?.project).toEqual(project);

    settleSharedTrustConfirmation('trust');
    expect(await teardown).toEqual(['docker compose down', 'rm -f .dev.pid']);
    await Promise.resolve();
    expect(getSharedTrustConfirmationSnapshot()?.project).toEqual(otherProject);

    settleSharedTrustConfirmation('skip');
    expect(await newSetup).toEqual(['cp .env.example .env']);
  });

  test('teardown without shared commands never asks', async () => {
    setup.shared.teardownWorktree = [];
    setup.teardownWorktree = ['rm -f .dev.pid'];
    expect(await resolveWorktreeTeardownCommands(project)).toEqual(['rm -f .dev.pid']);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('teardown nobody started by hand never asks: untrusted shared commands reject, trusted ones run', async () => {
    await expect(resolveWorktreeTeardownCommands(project, { ask: false })).rejects.toThrow('not trusted yet');
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();

    setup.trust.trusted = true;
    expect(await resolveWorktreeTeardownCommands(project, { ask: false })).toEqual(['docker compose down', 'rm -f .dev.pid']);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('teardown rejects when the setup cannot be read, so the removal stops', async () => {
    readFails = true;
    await expect(resolveWorktreeTeardownCommands(project)).rejects.toThrow('HTTP 500');
  });

  test('reset forgets the recorded answer', async () => {
    await resetSharedSetupTrust(project);
    expect(patches).toEqual([{ sharedTrustHash: null }]);
  });
});
