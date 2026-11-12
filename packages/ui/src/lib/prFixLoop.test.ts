import { describe, expect, test } from 'bun:test';
import { DEFAULT_PR_FIX_LOOP_CONFIG, fixLoopApprovalSchema, fixLoopSchema, isFixLoopWorkerReady, type FixLoopWorker } from './prFixLoop';
import type { SpaceEntry } from './spaces/spaces-api';

const legacyLoop = {
  id: 'loop-legacy', sessionId: 'ses_host', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix CI', branch: 'fix-ci', status: 'watching',
  statusReason: null, config: DEFAULT_PR_FIX_LOOP_CONFIG, iterations: 0, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null, pendingPushCommits: 3,
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};

describe('fix-loop approval parsing', () => {
  test('keeps a legacy auto loop readable without granting publication authority', () => {
    // Given an older server record without approval fields
    // When
    const result = fixLoopSchema.parse(legacyLoop);
    // Then
    expect(result).toMatchObject({ worker: null, pendingApproval: null, review: null });
    expect(result).not.toHaveProperty('pendingPushCommits');
  });

  test('rejects a malformed receipt instead of treating it as absent', () => {
    // Given
    const raw = { ...legacyLoop, config: { ...legacyLoop.config, pushMode: 'approval' }, pendingApproval: { id: 'bad' } };
    // When
    const result = fixLoopSchema.safeParse(raw);
    // Then
    expect(result.success).toBe(false);
  });

  test('rejects an unknown execution mode instead of defaulting to automatic pushes', () => {
    // Given
    const raw = { ...legacyLoop, config: { ...legacyLoop.config, pushMode: 'later' } };
    // When
    const result = fixLoopSchema.safeParse(raw);
    // Then
    expect(result.success).toBe(false);
  });
});

const worker: FixLoopWorker = {
  id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', spaceId: '012345abcdef', parentSessionId: 'ses_host', directory: '/repo',
  model: { providerID: 'openai', modelID: 'gpt-test' }, sessionId: null, spacePath: null,
};
const space: SpaceEntry = {
  id: worker.spaceId, kind: 'docker', purpose: 'pr-fix-loop-approval', name: 'pr-12', placeId: 'docker', machine: null,
  approvalModel: worker.model,
  projectDirectory: '/repo', directory: '/spaces/012345abcdef/repo', projectFolder: { path: '/repo', found: true },
  state: 'running', step: null, failure: null, stoppedIdle: false, network: { mode: 'allowlist', domains: [] },
  grants: [{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper/model/openai' }],
  access: 'granted', needsAccess: [], accessFailures: [], damage: null, setup: null,
};
const target = { sessionId: 'ses_host', directory: '/repo' };

describe('restricted worker activation', () => {
  test('admits a matching protected worker with authoritative model access', () => {
    // Given the host-confirmed prepared worker and space
    // When
    const ready = isFixLoopWorkerReady(worker, space, target);
    // Then
    expect(ready).toBe(true);
  });

  const incompatible: readonly Partial<SpaceEntry>[] = [
    { purpose: 'general' },
    { purpose: undefined },
    { approvalModel: undefined },
    { approvalModel: { providerID: 'openai', modelID: 'other-model' } },
    { state: 'preparing' },
    { access: 'unknown' },
    { access: null },
    { needsAccess: ['openai'] },
    { grants: [] },
    { damage: 'repairable' },
    { network: { mode: 'open', domains: [] } },
    { network: { mode: 'allowlist', domains: ['github.com'] } },
    { grants: [{ kind: 'custom', id: 'openai', provider: 'openai', url: 'http://gatekeeper/model/openai' }] },
  ];
  for (const [index, patch] of incompatible.entries()) {
    test(`refuses incomplete or incompatible worker authority ${index}`, () => {
      // Given
      const unavailable = { ...space, ...patch };
      // When
      const ready = isFixLoopWorkerReady(worker, unavailable, target);
      // Then
      expect(ready).toBe(false);
    });
  }

  test('refuses a preparation from another host session', () => {
    // Given
    const other = { ...worker, parentSessionId: 'ses_other' };
    // When
    const ready = isFixLoopWorkerReady(other, space, target);
    // Then
    expect(ready).toBe(false);
  });

  test('refuses a preparation from another directory', () => {
    // Given
    const other = { ...worker, directory: '/other' };
    // When
    const ready = isFixLoopWorkerReady(other, space, target);
    // Then
    expect(ready).toBe(false);
  });
});

describe('immutable publication identity', () => {
  test('rejects a receipt whose retained ref belongs to another receipt', () => {
    // Given
    const receipt = {
      id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', commit: 'a'.repeat(40),
      localRef: 'refs/heads/openchamber-approval/b95d2bca-d7b5-41c6-b52f-4f8a9623c76d', repositoryId: 'local-repo',
      destination: { headRepo: { id: 'github-repo', owner: 'fork', repo: 'repo' }, ref: 'refs/heads/fix', expectedHead: 'b'.repeat(40) },
      createdAt: 1, changedPaths: 1, changedBytes: 5,
    };
    // When
    const result = fixLoopApprovalSchema.safeParse(receipt);
    // Then
    expect(result.success).toBe(false);
  });
});
