import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ID, cleanupTransfers, transferFixture } from '../agent-server/space-transfer-fixture.js';
import { hostState, unexpectedChanges } from './code-in-bait.js';

afterEach(cleanupTransfers);
describe('front-door bundle journey', () => {
  it.each(['sha1', 'sha256'])('round trips a %s project, history, branch, changes and ref cleanup', async (format) => {
    // Given a real project with staged, unstaged and ignored files.
    const fixture = await transferFixture();
    if (format === 'sha256') {
      // Keep the same registered path while constructing the other object format.
      const { makeBait } = await import('./code-in-bait.js');
      const other = makeBait(fixture.host, { name: 'sha256', objectFormat: format });
      fs.rmSync(fixture.repo, { recursive: true });
      fs.renameSync(other.repo, fixture.repo);
    }
    const before = hostState(fixture.repo);
    // When code passes in and out through the authenticated agent transport.
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    const inside = fixture.local.local(arrived.spacePath);
    const gi = (args) => fixture.local.inside(['-C', inside, ...args]);
    expect(gi(['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('true');
    expect(fs.readFileSync(path.join(inside, 'tracked-to-edit.txt'), 'utf8')).toBe('one\ntwo staged\nthree unstaged\n');
    expect(fs.existsSync(path.join(inside, '.env'))).toBe(false);
    expect(await fixture.codeIn.sendHistory({ ...fixture.input, spacePath: arrived.spacePath, base: arrived.base })).toEqual({ status: 'sent' });
    expect(gi(['rev-list', '--count', 'HEAD']).stdout).toBe(fixture.g(['rev-list', '--count', 'HEAD']));
    fs.writeFileSync(path.join(inside, 'agent.txt'), 'from the space\n');
    const result = await fixture.codeOut.bringCodeOut({ ...fixture.input, spacePath: arrived.spacePath });
    expect(result.changedPaths).toBe(1);
    expect(await fixture.codeOut.describeApplyState(fixture.input)).toMatchObject({ newPaths: 1, changesRoute: 'open' });
    const branch = await fixture.codeOut.applyAsBranch({ ...fixture.input, branch: 'space-result' });
    expect(fixture.g(['show', `${branch.commit}:agent.txt`])).toBe('from the space\n');
    expect(await fixture.codeOut.applyAsChanges(fixture.input)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(fixture.repo, 'agent.txt'), 'utf8')).toBe('from the space\n');
    await fixture.codeIn.removeSpaceRefs(fixture.input);
    // Then the project retains the requested branch and changes, with no service refs.
    expect(fixture.g(['for-each-ref', '--format=%(refname)', `refs/openchamber/spaces/${ID}/`])).toBe('');
    const changed = unexpectedChanges(before, hostState(fixture.repo), { spaceIds: [ID], codeOut: true });
    expect(changed.filter((file) => file.startsWith('.git/') && !['.git/refs/heads/space-result', '.git/logs/refs/heads/space-result'].includes(file)
      && !file.startsWith('.git/objects/'))).toEqual([]);
    expect(fs.readdirSync(path.join(fixture.host.root, 'front-data/spaces/transfers'))).toEqual([]);
  });
  it('preserves a start ref when a fresh adapter sends history after restart', async () => {
    // Given an existing start created by one front-door instance.
    const fixture = await transferFixture();
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    const { createCodeIn } = await import('./code-in.js');
    const restarted = createCodeIn({ upstream: fixture.upstream, dataDir: path.join(fixture.host.root, 'restarted'), place: fixture.local.place });
    // When the mirror has gone and the adapter is constructed again.
    const result = await restarted.sendHistory({ ...fixture.input, base: arrived.base, spacePath: arrived.spacePath });
    // Then a fresh bundle reconstructs the source without resnapshotting the changed project.
    expect(result).toEqual({ status: 'sent' });
    expect(fixture.g(['rev-parse', `refs/openchamber/spaces/${ID}/start`]).trim()).toBe(arrived.start);
  });
  it('fails closed when the agent transport is unreachable', async () => {
    // Given an agent transport that refuses every call.
    const fixture = await transferFixture({ upstream: { request: async () => { throw Object.assign(new Error('unreachable'), { code: 'agent_unreachable' }); } } });
    // When project code is requested.
    await expect(fixture.codeIn.bringCodeIn(fixture.input)).rejects.toMatchObject({ code: 'agent_unreachable' });
    // Then no front-door git command or project mutation occurs.
    expect(fixture.executed).toEqual([]);
    expect(fixture.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });
  it('keeps shallow source code-in and reports host_shallow for history', async () => {
    // Given a shallow registered project with an uncommitted edit.
    const fixture = await transferFixture({ shallow: true });
    // When it is copied through the agent bundle path.
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    // Then its content arrives and the unavailable source history is explicit.
    expect(fs.readFileSync(path.join(fixture.local.local(arrived.spacePath), 'README.md'), 'utf8')).toBe('shallow uncommitted\n');
    expect(await fixture.codeIn.sendHistory({ ...fixture.input, base: arrived.base, spacePath: arrived.spacePath })).toEqual({ status: 'host_shallow' });
  });
  it.each(['unchanged', 'older'])('exports a result contained in the start history when the space is %s', async (mode) => {
    // Given a clean working tree copied using the default uncommitted-snapshot mode.
    const fixture = await transferFixture();
    fixture.g(['reset', '--hard', 'HEAD']);
    fixture.g(['clean', '-fd']);
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    await fixture.codeIn.sendHistory({ ...fixture.input, base: arrived.base, spacePath: arrived.spacePath });
    const inside = fixture.local.local(arrived.spacePath);
    if (mode === 'older') fixture.local.inside(['-C', inside, 'reset', '--hard', 'HEAD~1']);
    const expected = fixture.local.inside(['-C', inside, 'rev-parse', 'HEAD']).stdout.trim();
    // When preview brings that already-known commit out.
    const result = await fixture.codeOut.bringCodeOut({ ...fixture.input, spacePath: arrived.spacePath });
    // Then empty exclusion ranges still produce an importable result.
    expect(result.result).toBe(expected);
    expect(fixture.g(['rev-parse', `refs/openchamber/spaces/${ID}/result`]).trim()).toBe(expected);
  });
  it('promotes a new result when the agent project is shallow', async () => {
    // Given a space created from a shallow project.
    const fixture = await transferFixture({ shallow: true });
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    fs.writeFileSync(path.join(fixture.local.local(arrived.spacePath), 'shallow-result.txt'), 'new result\n');
    // When that result crosses both bundle trust boundaries.
    const result = await fixture.codeOut.bringCodeOut({ ...fixture.input, spacePath: arrived.spacePath });
    // Then the agent promotes it without adding unavailable source history.
    expect(fixture.g(['show', `${result.result}:shallow-result.txt`])).toBe('new result\n');
    expect(fixture.g(['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
  });
  it('reconstructs legacy snapshot metadata from the recorded base without resnapshotting', async () => {
    // Given an existing space start ref and the authoritative front-door record, with no agent sidecar.
    const fixture = await transferFixture();
    const arrived = await fixture.codeIn.bringCodeIn(fixture.input);
    fs.rmSync(path.join(fixture.dataDir, 'space-transfer', `${ID}.json`));
    const { createSpaceRecords } = await import('./space-records.js');
    createSpaceRecords({ dataDir: path.join(fixture.host.root, 'front-data') }).write(ID, {
      placeId: 'memory', network: { mode: 'open', domains: [] }, repository: fixture.repo, spacePath: arrived.spacePath, base: arrived.base,
    });
    fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'host changed after snapshot\n');
    // When code out needs a mirror after upgrade.
    await fixture.codeOut.bringCodeOut({ ...fixture.input, spacePath: arrived.spacePath });
    // Then metadata is reconstructed from the original refs and recorded base, preserving the old start.
    expect(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'space-transfer', `${ID}.json`))).start).toBe(arrived.start);
    expect(fixture.g(['rev-parse', `refs/openchamber/spaces/${ID}/start`]).trim()).toBe(arrived.start);
  });
});
