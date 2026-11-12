import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTransfers, transferFixture } from '../agent-server/space-transfer-fixture.js';
import { readBoundedBody } from '../agent-server/agent-upstream.js';
import { createCodeIn } from './code-in.js';
import { checkBundleHeader, checkSnapshotChain, importBundle, parseSnapshotMetadata, transferCaps, withBundleDirectory } from './transfer-bundle.js';

afterEach(cleanupTransfers);
const fakeResponse = (text) => Object.assign(Readable.from([Buffer.from(text)]), { statusCode: 200, complete: true });
const replacing = (fixture, replace) => createCodeIn({ upstream: { request: async (request) => {
  const response = await fixture.upstream.request(request);
  return request.path.includes('/snapshot?') ? fakeResponse(replace(JSON.parse(await readBoundedBody(response, 16384)))) : response;
} }, dataDir: path.join(fixture.host.root, 'front-invalid'), place: fixture.local.place });

describe('bundle trust boundaries', () => {
  it.each([
    ['malformed JSON', () => '{'],
    ['bad object id', (metadata) => JSON.stringify({ ...metadata, start: 'HEAD' })],
    ['foreign ref', (metadata) => JSON.stringify({ ...metadata, ref: 'refs/heads/main' })],
    ['bad clean chain', (metadata) => JSON.stringify({ ...metadata, mode: 'clean' })],
  ])('rejects %s from the agent before front-door git runs', async (_name, replace) => {
    // Given an authenticated agent whose metadata reply is corrupted in transit.
    const fixture = await transferFixture();
    // When a front-door transfer consumes that reply.
    await expect(replacing(fixture, replace).bringCodeIn(fixture.input)).rejects.toMatchObject({ code: 'agent_metadata_invalid' });
    // Then no local git command has accepted agent metadata.
    expect(fixture.executed).toEqual([]);
  });
  it('rejects a false staged parent when the ids are valid commits', async () => {
    // Given a valid start bundle and a wrong but well-formed staged id.
    const fixture = await transferFixture();
    const wrong = fixture.g(['rev-parse', 'HEAD~1']).trim();
    // When imported objects are compared with the declared parent chain.
    await expect(replacing(fixture, (metadata) => JSON.stringify({ ...metadata, staged: wrong })).bringCodeIn(fixture.input))
      .rejects.toMatchObject({ code: 'agent_snapshot_chain_invalid' });
    // Then the failed creation's start ref is removed on the agent.
    expect(fixture.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });
  it('rejects an oversized bundle from the agent while streaming', async () => {
    // Given a front door with a smaller bundle cap than its agent.
    const fixture = await transferFixture({ environment: { OPENCHAMBER_SPACE_BUNDLE_MAX_BYTES: '64' } });
    // When a valid repository exceeds that transport cap.
    await expect(fixture.codeIn.bringCodeIn(fixture.input)).rejects.toMatchObject({ code: 'agent_bundle_too_large' });
    // Then no transfer temporary directory remains.
    expect(fs.readdirSync(path.join(fixture.host.root, 'front-data/spaces/transfers'))).toEqual([]);
  });
  it('rejects metadata beyond the configured JSON cap', async () => {
    // Given valid metadata whose JSON representation has excessive trailing whitespace.
    const fixture = await transferFixture();
    // When the front door reads the bounded JSON reply.
    await expect(replacing(fixture, (metadata) => `${JSON.stringify(metadata)}${' '.repeat(20000)}`).bringCodeIn(fixture.input))
      .rejects.toMatchObject({ code: 'agent_metadata_invalid' });
    // Then no git command runs with that reply.
    expect(fixture.executed).toEqual([]);
  });
  it.each(['snapshot', 'result'])('refuses unexpected refs in a %s bundle header', async (kind) => {
    // Given a real bundle with a valid pack and an additional advertised branch.
    const fixture = await transferFixture();
    const metadata = await fixture.upstream.json(fixture.route('snapshot'), { method: 'POST', body: '{"mode":"clean"}' });
    const response = await fixture.upstream.request({ path: fixture.route('bundle') });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const boundary = bytes.indexOf('\n\n');
    const file = path.join(fixture.host.root, 'foreign.bundle');
    const ref = kind === 'snapshot' ? metadata.ref : metadata.ref.replace(/start$/, 'result');
    const header = `# v2 git bundle\n${kind === 'result' ? `-${metadata.start} start\n` : ''}${metadata.start} ${ref}\n${metadata.start} refs/heads/foreign\n\n`;
    fs.writeFileSync(file, Buffer.concat([Buffer.from(header), bytes.subarray(boundary + 2)]));
    // When either trust boundary inspects that header.
    if (kind === 'snapshot') {
      await expect(checkBundleHeader(file, { caps: fixture.caps, objectFormat: 'sha1', id: metadata.start, ref }))
        .rejects.toMatchObject({ code: 'agent_bundle_invalid' });
    } else {
      const uploaded = await fixture.upstream.request({ path: fixture.route('result', { start: metadata.start, result: metadata.start }),
        method: 'POST', body: fs.createReadStream(file) });
      expect(JSON.parse(await readBoundedBody(uploaded, 16384)).code).toBe('agent_bundle_invalid');
    }
    // Then no foreign branch is written into the agent's repository.
    expect(fixture.g(['for-each-ref', '--format=%(refname)', 'refs/heads/foreign'])).toBe('');
  });
  it('never runs planted hooks, templates or fsmonitor in the front-door import', async () => {
    // Given executable bait in the producing repository and the front-door global config.
    const fixture = await transferFixture();
    const marker = path.join(fixture.host.root, 'executed-marker');
    const hooks = path.join(fixture.host.root, 'bait-hooks');
    fs.mkdirSync(hooks);
    const script = `#!/bin/sh\nprintf ran >> '${marker}'\n`;
    for (const name of ['reference-transaction', 'post-index-change', 'pre-push', 'post-checkout']) fs.writeFileSync(path.join(hooks, name), script, { mode: 0o755 });
    const monitor = path.join(fixture.host.root, 'fsmonitor');
    fs.writeFileSync(monitor, script, { mode: 0o755 });
    fixture.g(['config', 'core.hooksPath', hooks]);
    fixture.g(['config', 'core.fsmonitor', monitor]);
    // Positive control establishes that both planted executables can run on this machine.
    fixture.host.sh(fixture.repo, ['status', '--porcelain']);
    fixture.host.sh(fixture.repo, ['update-ref', 'refs/control', 'HEAD']);
    expect(fs.readFileSync(marker, 'utf8').length).toBeGreaterThan(0);
    fs.rmSync(marker);
    const metadata = await fixture.upstream.json(fixture.route('snapshot'), { method: 'POST', body: '{"mode":"uncommitted"}' });
    const response = await fixture.upstream.request({ path: fixture.route('bundle') });
    const bundle = path.join(fixture.host.root, 'safe.bundle');
    const { receiveBundle } = await import('./transfer-bundle.js');
    await receiveBundle(response, bundle, fixture.caps);
    const globalConfig = path.join(fixture.host.root, 'hostile-global');
    fs.writeFileSync(globalConfig, `[core]\n hooksPath = ${hooks}\n fsmonitor = ${monitor}\n[init]\n templateDir = ${path.dirname(hooks)}\n`);
    // When a front-door-owned repository imports and inspects that bundle.
    await withBundleDirectory({ caps: transferCaps({}), temporaryDirectory: fixture.host.root,
      environment: { ...fixture.host.environment, GIT_CONFIG_GLOBAL: globalConfig, GIT_TEMPLATE_DIR: hooks } }, async ({ directory, git }) => {
      const mirror = path.join(directory, 'mirror');
      await git.output(directory, ['init', '--quiet', '--template=', mirror]);
      await importBundle(git, mirror, bundle, { caps: fixture.caps, objectFormat: 'sha1', id: metadata.start, ref: metadata.ref });
      await checkSnapshotChain(git, mirror, parseSnapshotMetadata(metadata, fixture.input.spaceId));
      await git.output(mirror, ['read-tree', metadata.start]);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(mirror, '.git/objects/info/alternates'))).toBe(false);
    });
    // Then neither the producing configuration nor inherited bait executes.
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('a project another account owns', () => {
  it('is trusted by the isolated git through its global scope, which git before 2.38 also reads', async () => {
    // Given a repository git treats as another account's, and a git that, like git before 2.38,
    // ignores safe.directory given with -c (Ubuntu 22.04 ships 2.34 with the ownership check).
    const fixture = await transferFixture();
    const oldGit = path.join(fixture.host.root, 'git-before-2.38');
    fs.writeFileSync(oldGit, [
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
    const read = (trust) => withBundleDirectory({ caps: transferCaps({}), temporaryDirectory: fixture.host.root, environment: fixture.host.environment,
      gitPath: oldGit, trust }, ({ git }) => git.output(fixture.repo, ['rev-parse', '--git-dir']));
    // When the isolated git reads it, then it does only when trusted, and the trust names nothing else.
    await expect(read([])).rejects.toThrow();
    expect((await read([fixture.repo])).trim()).toBe('.git');
    await expect(read([path.join(fixture.host.root, 'elsewhere')])).rejects.toThrow();
    // And git reads each folder back exactly, quotes, backslashes and comment characters included.
    const odd = ['/srv/a "quoted" name', '/srv/back\\slash', '/srv/hash # semi ;', '/srv/tab\tless'.replace('\t', ' ')];
    const listed = await withBundleDirectory({ caps: transferCaps({}), temporaryDirectory: fixture.host.root, environment: fixture.host.environment, trust: odd },
      ({ directory, git }) => git.output(directory, ['config', '--global', '--get-all', 'safe.directory']));
    expect(listed.split('\n').filter(Boolean)).toEqual(odd);
    await expect(withBundleDirectory({ caps: transferCaps({}), temporaryDirectory: fixture.host.root, trust: ['/srv/new\nline'] }, async () => {}))
      .rejects.toMatchObject({ code: 'agent_directory_invalid' });
  });
});
