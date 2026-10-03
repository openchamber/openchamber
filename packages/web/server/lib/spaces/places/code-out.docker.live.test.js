// Code out, from a real space on a real Docker daemon. Runs only with OPENCHAMBER_TEST_DOCKER=1.
// The bait comes in through code in, a scripted agent works inside, and its result comes out over
// `git fetch` through `docker exec` and is applied both ways. The escape attempts of TESTING.md that
// belong to code out run from inside, each with its control. Every test makes a space of its own
// and a repository of its own, so each runs alone as well as in order, and removes its space.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestHost, forConfig, hostState, makeBait, removeTestHosts, unexpectedChanges } from '../code-in-bait.js';
import { createSpaceId, hashProjectDirectory, spaceResourceName } from '../labels.js';
import { runCommand } from '../run-command.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const WIN = process.platform === 'win32';
const IMAGE_PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;';
// The same sizing as the hanging tests of code in: a measured `docker exec` round trip, with a 6 s
// host timeout and a 5 s margin as the floor.
const hangTiming = (roundTripMs) => {
  const hostTimeoutMs = Math.max(6000, 3 * roundTripMs + 3000);
  const innerMarginSeconds = Math.max(5, Math.ceil((4 * roundTripMs + 4000) / 1000));
  return { roundTripMs, hostTimeoutMs, innerMarginSeconds, innerLimitMs: hostTimeoutMs + innerMarginSeconds * 1000 };
};
// The docker calls between `started` and the fetch, where the limit inside begins to count: `execArgv`
// inspects, and the snapshot's `exec` inspects and runs.
const DOCKER_CALLS_BEFORE_FETCH = 3;

// What the agent can plant for the fetch out: git in the space reads its global config, and
// `uploadpack.packObjectsHook` from there runs in place of pack-objects. This one never ends.
const PLANT_HANGING_PACK_HOOK = [
  IMAGE_PATH,
  'printf "#!/bin/sh\\nexec /bin/sleep 1000\\n" > "$HOME/hang-pack" &&',
  'chmod 755 "$HOME/hang-pack" &&',
  'git config --global uploadpack.packObjectsHook "$HOME/hang-pack"',
].join(' ');
// A `packObjectsHook` that sends a pack without end: a header that promises a million objects,
// then one incompressible megabyte after another. Only the host's size cap stops it before its deadline.
const ENDLESS_PACK = [
  "const zlib = require('node:zlib'); const crypto = require('node:crypto');",
  "process.stdout.on('error', () => process.exit(0));",
  "const head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(1000000, 8); process.stdout.write(head);",
  'const blob = () => { let size = 1 << 20; const bytes = [(3 << 4) | (size & 15)]; size >>= 4;',
  'while (size) { bytes[bytes.length - 1] |= 0x80; bytes.push(size & 0x7f); size >>= 7; }',
  'return Buffer.concat([Buffer.from(bytes), zlib.deflateSync(crypto.randomBytes(1 << 20))]); };',
  "const pump = () => { while (process.stdout.write(blob())) {} process.stdout.once('drain', pump); }; pump();",
].join(' ');
const PLANT_ENDLESS_PACK_HOOK = [
  IMAGE_PATH,
  'printf "%s" "$1" > "$HOME/endless-pack.js" &&',
  'printf "#!/bin/sh\\nexec /usr/local/bin/node %s\\n" "$HOME/endless-pack.js" > "$HOME/endless-pack" &&',
  'chmod 755 "$HOME/endless-pack" &&',
  'git config --global uploadpack.packObjectsHook "$HOME/endless-pack"',
].join(' ');
const COUNT_ENDLESS = 'PATH=/usr/bin:/bin; n=0; for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null | grep -q "^/usr/local/bin/node /home/space/endless-pack.js" && n=$((n+1)); done; echo $n';
const COUNT_SLEEPERS = 'PATH=/usr/bin:/bin; n=0; for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null | grep -q "^/bin/sleep 1000" && n=$((n+1)); done; echo $n';
// The processes of a fetch out: the image's `timeout`, the upload-pack under it and its pack-objects.
// Anchored, so the counting script's own command line never counts.
const COUNT_UPLOADERS = 'PATH=/usr/bin:/bin; n=0; for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null | grep -qE "^(/usr/bin/timeout |/usr/bin/git upload-pack |git pack-objects )" && n=$((n+1)); done; echo $n';

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/** How many host processes name this container on their command line. The docker CLI of an exec always does. */
async function hostProcessesNaming(container) {
  if (WIN) {
    const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${container}*' -and $_.ProcessId -ne $PID }).Count`;
    const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return Number(result.stdout.trim());
  }
  const result = await runCommand('ps', ['-A', '-o', 'command=']);
  return result.stdout.split('\n').filter((command) => command.includes(container)).length;
}

/** Waits up to two seconds for the host processes that name the container to be gone. It must finish before the limit inside. */
async function hostProcessesGone(container, innerLimitAt) {
  let count = await hostProcessesNaming(container);
  for (let attempt = 0; attempt < 8 && count > 0; attempt += 1) {
    await pause(250);
    count = await hostProcessesNaming(container);
  }
  expect(Date.now(), 'the host check ran into the limit inside the space and proves nothing').toBeLessThan(innerLimitAt);
  return count === 0;
}

describe.skipIf(!LIVE_DOCKER_ENABLED)('code out: docker (live)', () => {
  let place;
  let dispose = async () => {};
  let host;
  let timing;

  const inside = (spaceId, script, args = []) => place.exec(spaceId, ['/bin/sh', '-c', `${IMAGE_PATH} ${script}`, 'sh', ...args], { timeoutMs: 120_000 });

  /**
   * A space of its own with a bait repository of its own brought in. `history: false` leaves the
   * space's repository shallow. `agent(script)` runs a script in the space's project folder as the agent.
   */
  const spaceWithCode = async (name, { history = true } = {}) => {
    const spec = { id: createSpaceId(), name, project: hashProjectDirectory(`/code/out/${name}`), created: new Date().toISOString(), memoryBytes: 1024 * 1024 * 1024 };
    await place.create(spec);
    const bait = makeBait(host, { name: `bait ${spec.id}` });
    const codeIn = host.codeIn(place);
    const came = await codeIn.bringCodeIn({ repository: bait.repo, spaceId: spec.id });
    if (history) await codeIn.sendHistory({ repository: bait.repo, spaceId: spec.id, spacePath: came.spacePath, base: came.base });
    const agent = async (script, args = []) => {
      const result = await inside(spec.id, `cd "$1" && shift && ${script}`, [came.spacePath, ...args]);
      expect(result.code, `the agent's script failed: ${result.stderr}`).toBe(0);
      return result.stdout;
    };
    const codeOut = host.codeOut(place);
    const request = (extra = {}) => ({ repository: bait.repo, spaceId: spec.id, spacePath: came.spacePath, ...extra });
    return { ...bait, id: spec.id, came, agent, codeOut, request, out: (extra) => codeOut.bringCodeOut(request(extra)), remove: () => place.remove(spec.id) };
  };

  beforeAll(async () => {
    ({ place, dispose } = createLiveDockerPlace());
    host = createTestHost({ ownHome: false });
    // The slowest of three round trips of `docker exec` sizes the hanging test. The space is removed afterwards.
    const probe = { id: createSpaceId(), name: 'Code out probe', project: hashProjectDirectory('/code/out/probe'), created: new Date().toISOString(), memoryBytes: 512 * 1024 * 1024 };
    await place.create(probe);
    let roundTripMs = 0;
    for (let sample = 0; sample < 3; sample += 1) {
      const sampleStarted = Date.now();
      await place.exec(probe.id, ['/bin/true']);
      roundTripMs = Math.max(roundTripMs, Date.now() - sampleStarted);
    }
    timing = hangTiming(roundTripMs);
    await place.remove(probe.id);
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
    removeTestHosts();
  }, CREATE_TIMEOUT_MS);

  it('brings the agent\'s work out and applies it as a branch and as uncommitted changes', async () => {
    const space = await spaceWithCode('Code out');
    const { repo, g } = space;
    await space.agent('printf "committed\\n" > committed.txt && printf "#!/bin/sh\\necho tool\\n" > tool.sh && chmod 755 tool.sh && git add committed.txt tool.sh && git commit --quiet -m "the agent commits"');
    const agentHead = (await space.agent('git rev-parse HEAD')).trim();
    await space.agent('printf "uncommitted\\n" >> tracked-to-edit.txt && printf "untracked\\n" > untracked-in-the-space.txt && git add untracked-in-the-space.txt');
    const statusInside = await space.agent('git status --porcelain=v1 --untracked-files=all');
    const before = hostState(repo);

    const out = await space.out();
    expect(g(['rev-parse', `${out.result}^`]).trim()).toBe(agentHead);
    expect(g(['log', '-1', '--format=%s', out.result]).trim()).toBe('openchamber: uncommitted changes from the space');
    expect(out.changedPaths).toBe(4);
    expect(out.nestedRepositories).toEqual({ count: 0, paths: [] });
    expect(out.unmerged).toEqual({ count: 0, paths: [] });
    expect(await space.agent('git status --porcelain=v1 --untracked-files=all')).toBe(statusInside);
    expect(unexpectedChanges(before, hostState(repo), { spaceIds: [space.id], codeOut: true })).toEqual([]);

    const statusBefore = g(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']);
    await space.codeOut.applyAsBranch({ repository: repo, spaceId: space.id, branch: 'from-the-space' });
    expect(g(['rev-parse', 'refs/heads/from-the-space']).trim()).toBe(out.result);
    expect(g(['ls-tree', 'refs/heads/from-the-space', 'tool.sh']).split(' ')[0]).toBe('100755');
    expect(g(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBefore);

    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: space.id })).toEqual({
      status: 'applied', appliedPaths: 4, remembered: true, nestedRepositories: { count: 0, paths: [] }, conflicted: { count: 0, paths: [] },
    });
    const status = g(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']);
    // The branch the space started from is unchanged; what came out is in the working tree, uncommitted.
    expect(status).toContain('?? committed.txt\n');
    expect(status).toContain('?? tool.sh\n');
    expect(status).toContain('?? untracked-in-the-space.txt\n');
    expect(status).toContain('MM tracked-to-edit.txt\n');
    expect(fs.readFileSync(path.join(repo, 'tracked-to-edit.txt'), 'utf8')).toBe('one\ntwo staged\nthree unstaged\nuncommitted\n');
    // The exec bit is lost on Windows, where git does not track it in a working tree.
    if (!WIN) expect(fs.statSync(path.join(repo, 'tool.sh')).mode & 0o777).toBe(0o755);

    // The agent works on, and a second apply brings only what is new since the first one.
    await space.agent('printf "more\\n" > second-round.txt');
    const second = await space.out();
    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: space.id })).toMatchObject({ status: 'applied', appliedPaths: 1, remembered: true });
    expect(g(['rev-parse', `refs/openchamber/spaces/${space.id}/applied`]).trim()).toBe(second.result);
    expect(fs.readFileSync(path.join(repo, 'second-round.txt'), 'utf8')).toBe('more\n');
    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: space.id })).toEqual({ status: 'nothing_to_apply' });

    // The user and the agent change the same line: from then on this space is applied as a branch.
    await space.agent('printf "more, from the agent\\n" > second-round.txt');
    const third = await space.out();
    fs.writeFileSync(path.join(repo, 'second-round.txt'), 'more, from the user\n');
    const refused = await space.codeOut.applyAsChanges({ repository: repo, spaceId: space.id }).catch((error) => error);
    expect(refused).toMatchObject({ code: 'changes_do_not_apply' });
    expect(refused.message).toMatch(/applied as a branch/);
    expect(fs.readFileSync(path.join(repo, 'second-round.txt'), 'utf8')).toBe('more, from the user\n');
    const closed = await space.codeOut.applyAsChanges({ repository: repo, spaceId: space.id }).catch((error) => error);
    expect(closed).toMatchObject({ code: 'changes_route_closed' });
    // The branch still holds the whole work, the rounds already applied included.
    const branch = await space.codeOut.applyAsBranch({ repository: repo, spaceId: space.id, branch: 'the-whole-work' });
    expect(branch.commit).toBe(third.result);
    expect(g(['ls-tree', '-r', '--name-only', 'refs/heads/the-whole-work']).split('\n')).toEqual(expect.arrayContaining(['committed.txt', 'second-round.txt', 'tool.sh']));
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  it('comes out of a space whose history has not arrived, and the user\'s repository stays complete', async () => {
    const space = await spaceWithCode('Code out, shallow', { history: false });
    expect((await space.agent('git rev-parse --is-shallow-repository')).trim()).toBe('true');
    await space.agent('printf "from a shallow space\\n" > shallow.txt');
    const out = await space.out();
    expect(space.g(['cat-file', 'blob', `${out.result}:shallow.txt`])).toBe('from a shallow space\n');
    expect(fs.existsSync(path.join(space.repo, '.git', 'shallow'))).toBe(false);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "Make the host run something through apply: git hooks, tags, refs outside the
  // quarantine namespace."
  it('runs nothing the agent planted on the host, and takes no tag and no ref but the result', async () => {
    const space = await spaceWithCode('Code out, planted');
    const hostMarker = path.join(host.root, `planted-ran-${space.id}`);
    // The planted hook marks the host's own folder, and only when that folder exists, which it does on
    // the host and never inside: a Windows path given to `touch` inside is a relative name full of
    // backslashes, and the file it made there travelled out in the result as part of the work. Forward
    // slashes, so the sh of Git for Windows reads the path as it is. Where it ran inside, it also marks
    // the repository's own git folder, which is never part of a snapshot.
    const hook = [
      '#!/bin/sh',
      `m="${forConfig(hostMarker)}"`,
      '[ -d "$(dirname "$m")" ] && touch "$m"',
      'touch "$(git rev-parse --git-dir)/planted-hook-ran"',
      'exit 0',
      '',
    ].join('\n');
    // Hooks and a filter in the space's own repository, a hooks folder and a filter in its tree, tags and refs.
    const plant = [
      'printf "%s" "$1" > .git/hooks/reference-transaction && chmod 755 .git/hooks/reference-transaction &&',
      'git config filter.planted.smudge "touch .git/planted-filter-ran; cat" && git config filter.planted.clean cat &&',
      'mkdir -p .githooks && cp .git/hooks/reference-transaction .githooks/post-checkout &&',
      'printf "* filter=planted\\n" > .gitattributes && printf "[core]\\n\\thooksPath = .githooks\\n" > .gitconfig &&',
      'git add --all && git commit --quiet -m planted &&',
      'git tag planted-light && git tag -a -m annotated planted-annotated && git update-ref refs/heads/planted-branch HEAD &&',
      'rm -f .git/planted-hook-ran',
    ].join(' ');
    await space.agent(plant, [hook]);
    // Nothing of the marks landed in the project folder inside, where the snapshot would take it.
    expect(await space.agent('git status --porcelain --untracked-files=all')).toBe('');
    const refsBefore = space.g(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);

    await space.out();
    // The control: the planted hook really ran, inside, when the snapshot wrote its ref.
    expect(await space.agent('[ -e .git/planted-hook-ran ] && echo ran; true')).toBe('ran\n');
    expect(space.g(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean)).toEqual([...refsBefore, `refs/openchamber/spaces/${space.id}/result`].sort());
    await space.codeOut.applyAsBranch({ repository: space.repo, spaceId: space.id, branch: 'from-the-space' });
    await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: space.id });
    expect(fs.existsSync(path.join(space.repo, '.githooks', 'post-checkout'))).toBe(true);
    expect(fs.existsSync(hostMarker)).toBe(false);
    // The control, on the host: the planted hook that came out is a working hook that marks the host
    // when git is told to use it, so its silence above is the host not running it, not a dud.
    const probe = spawnSync('git', ['-C', space.repo, '-c', 'core.hooksPath=.githooks', 'checkout', '--quiet', '-b', 'probe'], { env: host.environment, encoding: 'utf8', windowsHide: true });
    expect(probe.status, probe.stderr).toBe(0);
    expect(fs.existsSync(hostMarker)).toBe(true);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // A hook of the agent's can reach its parent git's stdout through /proc and write a commit id of its
  // own there, then move the result ref to that commit. The snapshot sends everything it runs to
  // /dev/null, so what the host reads first is still the snapshot's own id, and the moved ref is
  // refused rather than taken. The verifier who found this showed that removing the redirect makes
  // the host take the planted commit.
  it('does not let a hook print into the report through its parent\'s stdout', async () => {
    const space = await spaceWithCode('Code out, stdout hook');
    const planted = (await space.agent([
      'blob=$(printf "planted\\n" | git hash-object -w --stdin) &&',
      'tree=$(printf "100644 blob %s\\tplanted.txt\\n" "$blob" | git mktree) &&',
      'git commit-tree "$tree" -p HEAD -m planted',
    ].join(' '))).trim();
    const hook = [
      '#!/bin/sh',
      '[ "$1" = committed ] || exit 0',
      'marker="$(git rev-parse --git-dir)/stdout-hook-ran"',
      '[ -e "$marker" ] && exit 0',
      ': > "$marker"',
      `printf '%s\\n' ${planted} > /proc/$PPID/fd/1`,
      `( sleep 1; git update-ref refs/openchamber/result ${planted} ) &`,
      'exit 0',
      '',
    ].join('\n');
    await space.agent('printf "%s" "$1" > .git/hooks/reference-transaction && chmod 755 .git/hooks/reference-transaction && printf "work\\n" > work.txt', [hook]);
    const before = hostState(space.repo);
    const failure = await space.out().catch((error) => error);
    // The control: the hook ran on the snapshot's own ref write.
    expect(await space.agent('[ -e .git/stdout-hook-ran ] && echo ran; true')).toBe('ran\n');
    expect(failure).toMatchObject({ code: 'result_ref_missing', details: { step: 'fetch into the quarantine' } });
    expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] })).toEqual([]);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "Get tree paths such as `.git/hooks/x`, `.GIT`, `..`, or `a/../../x` past the host's
  // object checks." Each tree is built inside with the space's own git, past its path checks.
  it('refuses hostile tree names at the quarantine, and brings the same kind of tree out with an ordinary name', async () => {
    const space = await spaceWithCode('Code out, hostile trees');
    const planted = [
      'blob=$(printf "planted\\n" | git hash-object -w --stdin) &&',
      'entry() { /usr/local/bin/node -e "process.stdout.write(Buffer.concat([Buffer.from(process.argv[1] + \' \' + process.argv[2] + String.fromCharCode(0)), Buffer.from(process.argv[3], \'hex\')]))" "$1" "$2" "$3" | git hash-object -t tree --literally -w --stdin; } &&',
      'if [ "$1" = ".git/hooks/x" ]; then t=$(entry 100644 x $blob) && t=$(entry 40000 hooks $t) && tree=$(entry 40000 .git $t); else tree=$(entry 100644 "$1" $blob); fi &&',
      'git update-ref HEAD $(git commit-tree $tree -p HEAD -m planted)',
    ].join(' ');
    const head = (await space.agent('git rev-parse HEAD')).trim();
    const before = hostState(space.repo);
    for (const name of ['.git', '.GIT', 'git~1', '.git ', '..', 'a/../../x', '.git/hooks/x']) {
      await space.agent(planted, [name]);
      const failure = await space.out().catch((error) => error);
      expect(failure, name).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine' } });
      expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] }), name).toEqual([]);
      await space.agent('git update-ref HEAD "$1"', [head]);
    }
    // The control: built the same way, an ordinary name comes out. The planted commit is the parent
    // of the result, whose own tree is the working tree the snapshot took.
    await space.agent(planted, ['ordinary.txt']);
    const out = await space.out();
    expect(space.g(['cat-file', 'blob', `${out.result}^:ordinary.txt`])).toBe('planted\n');
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "write through a symlink or into `.git/` when applied as a patch". `.git/` cannot come
  // out at all, see above; a folder of the space where the user has a link is refused at apply.
  it('writes nothing through a link the user has where the space made a folder, and brings a link to outside in as a link only', async () => {
    const space = await spaceWithCode('Code out, links');
    const outside = path.join(host.root, `outside-${space.id}`);
    fs.mkdirSync(outside);
    await space.agent('mkdir -p cache && printf "through the link\\n" > cache/planted.txt && ln -s /etc/passwd link-outside');
    const out = await space.out();
    // The control: the result does hold the file and the link.
    expect(space.g(['cat-file', 'blob', `${out.result}:cache/planted.txt`])).toBe('through the link\n');
    expect(space.g(['ls-tree', out.result, 'link-outside']).split(' ')[0]).toBe('120000');
    fs.appendFileSync(path.join(space.repo, '.git', 'info', 'exclude'), 'cache\n');
    fs.symlinkSync(outside, path.join(space.repo, 'cache'), WIN ? 'junction' : 'dir');
    const before = hostState(space.repo);
    // Refused by the host's own look at the folders on the way, not by git: Git for Windows writes
    // through a junction.
    await expect(space.codeOut.applyAsChanges({ repository: space.repo, spaceId: space.id })).rejects.toMatchObject({ code: 'changes_blocked_by_link', details: { path: 'cache' } });
    expect(fs.readdirSync(outside)).toEqual([]);
    // The one thing a refused apply writes: from now on this space is applied as a branch.
    expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] })).toEqual([`.git/refs/openchamber/spaces/${space.id}/changes-closed`]);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "Hang the result fetch forever ... The host's timeout ... must end it, and the process
  // left inside the space must be cleaned up."
  it('ends a fetch that the space never answers at the host timeout, with no host process left and nothing inside after its limit', async () => {
    const space = await spaceWithCode('Code out, hanging');
    await space.agent('printf "work\\n" > work.txt');
    expect((await inside(space.id, PLANT_HANGING_PACK_HOOK)).code).toBe(0);
    const before = hostState(space.repo);
    const started = Date.now();
    const failure = await space.out({ timeoutMs: timing.hostTimeoutMs, innerMarginSeconds: timing.innerMarginSeconds }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine', cause: 'command_timeout' } });
    // The control: the planted hook really held the fetch inside, and still does.
    expect(Number((await inside(space.id, COUNT_SLEEPERS)).stdout)).toBeGreaterThan(0);
    expect(await hostProcessesGone(spaceResourceName(space.id, 'space'), started + timing.innerLimitMs)).toBe(true);
    const bound = started + timing.innerLimitMs + (DOCKER_CALLS_BEFORE_FETCH + 2) * timing.roundTripMs + 3000;
    let emptied = false;
    while (!emptied && Date.now() <= bound + 500) {
      emptied = (await inside(space.id, COUNT_SLEEPERS)).stdout === '0\n';
      if (!emptied) await pause(500);
    }
    expect(emptied, 'the fetch inside outlived the limit inside the space').toBe(true);
    expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] })).toEqual([]);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "... or fill the host's disk with it. The host's ... size cap must end" it. A space
  // that sends without end is stopped by the cap long before the deadline, which is what shows that
  // the cap watches the transfer while it runs, not only once it is over.
  it('stops a space that sends without end at the size cap, long before the deadline, with nothing left on the host or inside', async () => {
    const space = await spaceWithCode('Code out, endless');
    await space.agent('printf "work\\n" > work.txt');
    expect((await inside(space.id, PLANT_ENDLESS_PACK_HOOK, [ENDLESS_PACK])).code).toBe(0);
    const before = hostState(space.repo);
    const started = Date.now();
    const failure = await space.out({ maxTransferBytes: 4 * 1024 * 1024, timeoutMs: 90_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_transfer_too_large', details: { step: 'fetch into the quarantine' } });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(await hostProcessesGone(spaceResourceName(space.id, 'space'), started + 95_000)).toBe(true);
    expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] })).toEqual([]);
    // Nothing of it runs inside once the limit there has passed.
    let emptied = false;
    while (!emptied && Date.now() <= started + 100_000) {
      emptied = (await inside(space.id, COUNT_ENDLESS)).stdout === '0\n';
      if (!emptied) await pause(500);
    }
    expect(emptied).toBe(true);
    await space.remove();
  }, CREATE_TIMEOUT_MS);

  // TESTING.md: "... or fill the host's disk with it. The host's ... size cap must end" it.
  it('stops a fetch that passes the size cap, with no host process left, and brings the same work out with room for it', async () => {
    const space = await spaceWithCode('Code out, large');
    await space.agent('head -c 16777216 /dev/urandom > large.bin');
    const before = hostState(space.repo);
    const failure = await space.out({ maxTransferBytes: 4 * 1024 * 1024, timeoutMs: 120_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_transfer_too_large', details: { step: 'fetch into the quarantine' } });
    expect(await hostProcessesGone(spaceResourceName(space.id, 'space'), Date.now() + 60_000)).toBe(true);
    expect(unexpectedChanges(before, hostState(space.repo), { spaceIds: [] })).toEqual([]);
    // Nothing of the fetch runs inside once the limit there has passed.
    const bound = Date.now() + 125_000;
    let emptied = false;
    while (!emptied && Date.now() <= bound) {
      emptied = (await inside(space.id, COUNT_UPLOADERS)).stdout === '0\n';
      if (!emptied) await pause(500);
    }
    expect(emptied).toBe(true);
    // The control: with the default cap the same result comes out.
    const out = await space.out();
    expect(out.changedBytes).toBe(16 * 1024 * 1024);
    await space.remove();
  }, CREATE_TIMEOUT_MS);
});
