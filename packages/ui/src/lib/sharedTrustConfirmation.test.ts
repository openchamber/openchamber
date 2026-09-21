import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ProjectSetup } from './openchamberConfig';

const project = { id: 'p', path: '/repo' };

let setup: ProjectSetup;
let patches: Array<Record<string, unknown>> = [];
let saveOk = true;

mock.module('./openchamberConfig', () => ({
  getProjectSetup: mock(async () => setup),
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
  settleSharedTrustConfirmation,
} = await import('./sharedTrustConfirmation');

const baseSetup = (): ProjectSetup => ({
  trust: { hash: 'sha256:abc', trusted: false },
  setupWorktree: ['bun install', 'cp .env.example .env'],
  setupWorktreeWait: false,
  projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'shared' }],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'ok',
    path: '.openchamber/project.json',
    setupWorktree: ['bun install'],
    setupWorktreeWait: null,
    projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: ['cp .env.example .env'],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
  },
});

describe('shared trust confirmation', () => {
  beforeEach(() => {
    setup = baseSetup();
    patches = [];
    saveOk = true;
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
    settleSharedTrustConfirmation('skip');
    expect(await pending).toEqual(['cp .env.example .env']);
    expect(patches).toEqual([]);
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

  test('reset forgets the recorded answer', async () => {
    await resetSharedSetupTrust(project);
    expect(patches).toEqual([{ sharedTrustHash: null }]);
  });
});
