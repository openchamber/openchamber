import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createSpaceWorker } from './space-worker.js';
import { createSpaceRecords } from '../spaces/space-records.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const dataDir = await fs.mkdtemp('/tmp/opencode/d2c-worker-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const worker = { id: '12345678-1234-4234-8234-123456789abc', spaceId: 'aabbccddeeff', directory: '/repo', parentSessionId: 'ses_host',
    model: { providerID: 'openai', modelID: 'gpt-4.1' }, sessionId: null, spacePath: null };
  createSpaceRecords({ dataDir }).write(worker.spaceId, { purpose: 'pr-fix-loop-approval', approvalModel: worker.model,
    repository: '/repo', spacePath: '/spaces/aabbccddeeff/repo', network: { mode: 'allowlist', domains: [] },
    grants: [{ kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'TEST_KEY' } }] });
  const manager = { verify: async () => [], exec: vi.fn(async () => ({ code: 0 })), execArgv: vi.fn() };
  const getHost = () => ({ manager, journey: { listSpaces: async () => [{ id: worker.spaceId, purpose: 'pr-fix-loop-approval', state: 'running', access: 'granted', needsAccess: [] }] },
    dispatcher: { requestInside: vi.fn(async () => Object.assign(Readable.from([Buffer.from(JSON.stringify({ data: { id: 'ses_worker' } }))]), { statusCode: 200 })) } });
  const seedHead = vi.fn(async () => {});
  const git = { output: vi.fn(async () => { throw new Error('front door must not use local project git'); }) };
  const fetchHead = vi.fn();
  const service = createSpaceWorker({ dataDir, getHost, git, gitServices: () => ({ fetchHead }), seedHead,
    readHostSession: async () => ({ id: 'ses_host', location: { directory: '/repo' } }) });
  return { service, seedHead, git, fetchHead, manager, worker };
}
test('front-door worker initialization uses only the delegated exact-head sender and local Space control', async () => {
  const fixture = await setup(); const head = 'a'.repeat(40);
  const loop = { id: 'fixloop_owner', worker: fixture.worker, directory: '/repo', sessionId: 'ses_host', number: 7 };
  const initialized = await fixture.service.initialize(loop, { headSha: head });
  expect(fixture.seedHead).toHaveBeenCalledExactlyOnceWith(loop, { headSha: head }, {
    manager: fixture.manager, spaceId: fixture.worker.spaceId, spacePath: '/spaces/aabbccddeeff/repo',
  });
  expect(fixture.manager.exec.mock.calls[0][1]).toEqual(['/usr/bin/git', '-C', '/spaces/aabbccddeeff/repo', 'checkout', '--force', '--detach', head]);
  expect(initialized.sessionId).toBe('ses_worker'); expect(fixture.git.output).not.toHaveBeenCalled(); expect(fixture.fetchHead).not.toHaveBeenCalled();
});
test('failed agent seeding cannot check out or create a worker session through a local project fallback', async () => {
  const fixture = await setup();
  fixture.seedHead.mockRejectedValue(Object.assign(new Error('agent_unreachable'), { code: 'agent_unreachable' }));
  await expect(fixture.service.initialize({ id: 'fixloop_owner', worker: fixture.worker, directory: '/repo', sessionId: 'ses_host', number: 7 },
    { headSha: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'agent_unreachable' });
  expect(fixture.manager.exec).not.toHaveBeenCalled(); expect(fixture.git.output).not.toHaveBeenCalled(); expect(fixture.fetchHead).not.toHaveBeenCalled();
});
