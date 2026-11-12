import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentHeadTransfer } from './agent-head-transfer.js';
import { createApprovalPublication } from './publication.js';
import { createAgentFixLoopProject } from '../agent-server/fix-loop-project.js';
import { createAgentFixLoopServices } from '../agent-server/fix-loop-services.js';
import { cleanupFixLoops, fixLoopServiceFixture, REF } from '../agent-server/fix-loop-test-fixture.js';
import { cleanupTransfers, ID, transferFixture } from '../agent-server/space-transfer-fixture.js';

afterEach(async () => { await cleanupFixLoops(); await cleanupTransfers(); });
async function setup({ otherOwner = false } = {}) {
  // A project of another account, as separated installs have: git refuses it unless the agent trusts it.
  const owner = otherOwner ? { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } : {};
  const fixture = await transferFixture({ agentEnvironment: owner });
  if (otherOwner) fs.appendFileSync(fixture.host.environment.GIT_CONFIG_GLOBAL, `\n[safe]\n\tdirectory = ${fixture.repo}\n`);
  const http = await fixLoopServiceFixture({ projectDirectory: fixture.repo });
  // Only the project is foreign: the agent's own scratch repositories stay its own. Like git before 2.38,
  // this git also ignores safe.directory given with -c.
  const gitPath = path.join(fixture.host.root, 'foreign-project-git');
  fs.writeFileSync(gitPath, [
    '#!/bin/sh',
    `[ "$1" = -C ] && [ "$2" = '${fixture.repo}' ] && export GIT_TEST_ASSUME_DIFFERENT_OWNER=1`,
    'pending=',
    'for arg do',
    '  shift',
    '  if [ -n "$pending" ]; then pending=; case "$arg" in safe.directory=*) continue ;; esac; set -- "$@" -c; fi',
    '  if [ "$arg" = -c ]; then pending=1; continue; fi',
    '  set -- "$@" "$arg"',
    'done',
    '[ -n "$pending" ] && set -- "$@" -c',
    'exec git "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  const project = createAgentFixLoopProject({ dataDir: http.root, environment: fixture.host.environment,
    resolveGitPath: otherOwner ? () => gitPath : undefined });
  http.project.readHead.mockImplementation(project.readHead);
  http.project.exportHead.mockImplementation(project.exportHead);
  http.project.captureRef.mockImplementation(project.captureRef);
  Object.assign(http.project.caps, project.caps);
  const services = createAgentFixLoopServices(http.upstream);
  const seed = createAgentHeadTransfer({ upstream: http.upstream, services, dataDir: path.join(fixture.host.root, 'front-data'),
    environment: fixture.host.environment, runCommand: async (file, args, options) => {
      expect(args).not.toContain(fixture.repo);
      const { runCommand } = await import('../spaces/run-command.js');
      return runCommand(file, args, options);
    } });
  return { ...fixture, http, project, services, seed };
}
test('seeds the exact PR head through a private mirror and promotes normal D2a code out without opening the project', async () => {
  const fixture = await setup();
  const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
  const head = fixture.g(['rev-parse', 'HEAD~1']).trim();
  const beforeHead = fixture.g(['rev-parse', 'HEAD']);
  const beforeIndex = fixture.g(['ls-files', '--stage']);
  const dirty = fs.readFileSync(path.join(fixture.repo, 'tracked-to-edit.txt'), 'utf8');
  const loop = { ...fixture.http.context, directory: fixture.repo, readContext: fixture.http.context,
    owner: 'upstream', repo: 'app', number: 7 };
  await fixture.seed(loop, { headSha: head }, { manager: fixture.local.place, spaceId: ID, spacePath: arrived.spacePath });
  expect(fixture.http.git.fetchHead.mock.calls[0][1]).toEqual({ headSha: head });
  const inside = fixture.local.local(arrived.spacePath);
  expect(fixture.local.inside(['-C', inside, 'rev-parse', 'refs/heads/openchamber-fix-loop']).stdout.trim()).toBe(head);
  expect(fixture.local.inside(['-C', inside, 'checkout', '--force', '--detach', head]).code).toBe(0);
  fs.writeFileSync(path.join(inside, 'approved.txt'), 'protected worker result\n');
  const result = await fixture.codeOut.bringCodeOut({ ...fixture.input, spacePath: arrived.spacePath });
  expect(fixture.g(['show', `${result.result}:approved.txt`])).toBe('protected worker result\n');
  await fixture.services.captureRef({ directory: fixture.repo, commit: result.result, expectedHead: head, localRef: REF });
  expect(fixture.g(['rev-parse', REF]).trim()).toBe(result.result);
  expect(fixture.g(['rev-parse', 'HEAD'])).toBe(beforeHead);
  expect(fixture.g(['ls-files', '--stage'])).toBe(beforeIndex);
  expect(fs.readFileSync(path.join(fixture.repo, 'tracked-to-edit.txt'), 'utf8')).toBe(dirty);
  expect(fs.readdirSync(path.join(fixture.host.root, 'front-data/spaces/transfers'))).toEqual([]);
});
test('private head imports reject additional refs before a Space transport is reached', async () => {
  const fixture = await setup();
  const head = fixture.g(['rev-parse', 'HEAD']).trim();
  fixture.http.project.exportHead.mockImplementation(async (input, file) => {
    await fixture.project.exportHead(input, file);
    const bytes = fs.readFileSync(file);
    const offset = bytes.indexOf('\n\n');
    fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, offset), Buffer.from(`\n${head} refs/heads/extra`), bytes.subarray(offset)]));
  });
  const manager = { execArgv: vi.fn() };
  await expect(fixture.seed({ directory: fixture.repo, readContext: fixture.http.context, owner: 'upstream', repo: 'app', number: 7 },
    { headSha: head }, { manager, spaceId: ID, spacePath: `/spaces/${ID}/project` })).rejects.toMatchObject({ code: 'agent_bundle_invalid' });
  expect(manager.execArgv).not.toHaveBeenCalled();
});
test('agent receipt capture requires exact ancestry and exclusive ref creation', async () => {
  const fixture = await setup();
  const head = fixture.g(['rev-parse', 'HEAD~1']).trim();
  const commit = fixture.g(['rev-parse', 'HEAD']).trim();
  const input = { directory: fixture.repo, commit, expectedHead: head, localRef: REF };
  await fixture.services.captureRef(input);
  await expect(fixture.services.captureRef({ ...input, commit: head })).rejects.toThrow();
  expect(fixture.g(['rev-parse', REF]).trim()).toBe(commit);
  const unrelated = fixture.g(['commit-tree', '--no-gpg-sign', `${commit}^{tree}`, '-m', 'unrelated']).trim();
  await expect(fixture.services.captureRef({ ...input, commit: unrelated, localRef: REF.replace('12345678', '87654321') }))
    .rejects.toMatchObject({ code: 'agent_fix_loop_unrelated_result' });
});
test('exact-head bundle byte limits end transfer before any local Space operation', async () => {
  const fixture = await setup();
  const head = fixture.g(['rev-parse', 'HEAD']).trim();
  const manager = { execArgv: vi.fn() };
  const dataDir = path.join(fixture.host.root, 'bounded-front');
  const seed = createAgentHeadTransfer({ upstream: fixture.http.upstream, services: fixture.services, dataDir,
    environment: { ...fixture.host.environment, OPENCHAMBER_SPACE_BUNDLE_MAX_BYTES: '64' } });
  await expect(seed({ directory: fixture.repo, readContext: fixture.http.context, owner: 'upstream', repo: 'app', number: 7 },
    { headSha: head }, { manager, spaceId: ID, spacePath: `/spaces/${ID}/project` })).rejects.toMatchObject({ code: 'agent_bundle_too_large' });
  expect(manager.execArgv).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(dataDir, 'spaces/transfers'))).toEqual([]);
});
test('front-door publication generates its receipt and authority and delegates only the exact captured object', async () => {
  const captureRef = vi.fn(async () => undefined);
  const readBinding = vi.fn(async () => ({ repository: { repositoryId: 'repository', configRevision: 'config',
    remotes: [{ name: 'fork', push: { displayUrl: 'https://github.com/contributor/app.git', fingerprint: 'fingerprint' } }] },
    revision: 2, binding: { remotes: [{ name: 'fork', readiness: 'ready', mode: 'managed' }] } }));
  const publication = createApprovalPublication({ git: null, dataDir: '/no-project-access', gitServices: () => ({ readBinding }), captureRef });
  const head = 'a'.repeat(40); const commit = 'b'.repeat(40);
  const output = { result: commit, changedPaths: 1, changedBytes: 2, unmerged: { count: 0 }, nestedRepositories: { count: 0 },
    id: 'forged', localRef: 'refs/heads/forged', authority: 'forged' };
  const pending = await publication.capture({ directory: '/repo', readContext: { repositoryId: 'repository', bindingRevision: 2 } },
    { headSha: head, branch: 'fix', headRepo: { id: 'fork', owner: 'contributor', repo: 'app' } }, output);
  expect(pending.receipt.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(pending.receipt.localRef).toBe(`refs/heads/openchamber-approval/${pending.receipt.id}`);
  expect(captureRef).toHaveBeenCalledExactlyOnceWith({ directory: '/repo', commit, expectedHead: head, localRef: pending.receipt.localRef });
  expect(pending.authority).toMatchObject({ repositoryId: 'repository', bindingRevision: 2, remote: { name: 'fork' } });
});
test('seeds and captures in a project another account owns, which the agent trusts', async () => {
  // Given a project git treats as another account's, which the agent's global config trusts, as git-trust.js makes it.
  const fixture = await setup({ otherOwner: true });
  const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
  const head = fixture.g(['rev-parse', 'HEAD~1']).trim();
  const commit = fixture.g(['rev-parse', 'HEAD']).trim();
  const loop = { directory: fixture.repo, readContext: fixture.http.context, owner: 'upstream', repo: 'app', number: 7 };
  // When the front door seeds the PR head into the worker and captures a receipt ref.
  await fixture.seed(loop, { headSha: head }, { manager: fixture.local.place, spaceId: ID, spacePath: arrived.spacePath });
  await fixture.services.captureRef({ directory: fixture.repo, commit, expectedHead: head, localRef: REF });
  // Then both run, though the agent's isolated git reads no global configuration.
  const inside = fixture.local.local(arrived.spacePath);
  expect(fixture.local.inside(['-C', inside, 'rev-parse', 'refs/heads/openchamber-fix-loop']).stdout.trim()).toBe(head);
  expect(fixture.g(['rev-parse', REF]).trim()).toBe(commit);
});
