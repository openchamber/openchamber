// Code in, into a real space on a real Docker daemon. Runs only with OPENCHAMBER_TEST_DOCKER=1.
// The bait repository arrives over `git push` through `docker exec`, and a space whose receiving
// side never answers is ended by the host's timeout with nothing left on the host. Every test runs
// alone as well as in order: the shared code in happens in `beforeAll`, and the hanging tests make
// spaces of their own.

import zlib from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OBJECTS_ONLY_TEXT, SECRET, createTestHost, hostState, makeBait, removeTestHosts, shortStatus, unexpectedChanges } from '../code-in-bait.js';
import { createSpaceId, hashProjectDirectory, spaceResourceName } from '../labels.js';
import { runCommand } from '../run-command.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const WIN = process.platform === 'win32';
// The timing of the hanging tests. After the host gives up, and before the limit inside ends the
// receiver, the tests count what still runs inside and check the host's processes: that window is
// the inner margin. Over `DOCKER_HOST=ssh://` every docker call opens its own SSH connection, so the
// window is sized from a measured `docker exec` round trip, with today's local values as the floor:
// a 6 s host timeout and a 5 s margin. The deadline is counted from before the call, while the push
// starts a few docker calls later, so up to three round trips of skew are paid for as well.
const hangTiming = (roundTripMs) => {
  const hostTimeoutMs = Math.max(6000, 3 * roundTripMs + 3000);
  const innerMarginSeconds = Math.max(5, Math.ceil((4 * roundTripMs + 4000) / 1000));
  return { roundTripMs, hostTimeoutMs, innerMarginSeconds, innerLimitMs: hostTimeoutMs + innerMarginSeconds * 1000 };
};

// The docker calls each hanging test makes between `started` and the push, where the limit inside
// begins to count. Every `exec` of the place inspects first, so it costs two. Code in: `execArgv`,
// then the init script. The history: `execArgv`, the shallow check, then the side repository's init.
const DOCKER_CALLS_BEFORE_CODE_IN_PUSH = 3;
const DOCKER_CALLS_BEFORE_HISTORY_PUSH = 5;

// What the agent could have done inside by the time the history travels: a global git config in
// its HOME that points every git at hooks of its own, and a pre-receive hook that never ends.
const PLANT_HANGING_HOOK = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;',
  'mkdir -p "$HOME/planted-hooks" &&',
  'printf "#!/bin/sh\\nexec /bin/sleep 1000\\n" > "$HOME/planted-hooks/pre-receive" &&',
  'chmod 755 "$HOME/planted-hooks/pre-receive" &&',
  'git config --global core.hooksPath "$HOME/planted-hooks"',
].join(' ');
const COUNT_SLEEPERS = 'PATH=/usr/bin:/bin; n=0; for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null | grep -q "^/bin/sleep 1000" && n=$((n+1)); done; echo $n';

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/**
 * Waits up to two seconds for the host processes that name the container to be gone, and says
 * whether they went. It must finish before the limit inside the space: that limit ends a leftover
 * `docker exec` on its own, and a check that waited for it would pass without the tree kill.
 */
async function hostProcessesGone(container, innerLimitAt) {
  let count = await hostProcessesNaming(container);
  for (let attempt = 0; attempt < 8 && count > 0; attempt += 1) {
    await pause(250);
    count = await hostProcessesNaming(container);
  }
  expect(Date.now(), 'the host check ran into the limit inside the space and proves nothing').toBeLessThan(innerLimitAt);
  return count === 0;
}

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

describe.skipIf(!LIVE_DOCKER_ENABLED)('code in: docker (live)', () => {
  const newSpec = (name) => ({
    id: createSpaceId(),
    name,
    project: hashProjectDirectory('/code/in/project'),
    created: new Date().toISOString(),
    memoryBytes: 1024 * 1024 * 1024,
  });
  const spec = newSpec('Code in');
  const spaceIds = [spec.id];
  let place;
  let dispose = async () => {};
  let repo;
  let g;
  let codeIn;
  let before;
  let result;
  let timing;

  const inside = (spaceId, script, args = []) => place.exec(spaceId, ['/bin/sh', '-c', `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ${script}`, 'sh', ...args], { timeoutMs: 120_000 });
  const insideRepo = async (args) => (await inside(spec.id, 'cd "$1" && shift && git "$@"', [result.spacePath, ...args])).stdout;
  const unchanged = () => unexpectedChanges(before, hostState(repo), { spaceIds });

  /**
   * Whether nothing of the planted hook runs inside any more, asked until the limit inside has passed
   * counted from the latest moment the push could have started: `started`, the docker calls before the
   * push, two more round trips for the push's own `docker exec` to begin, and a few seconds. A receiver
   * with no limit inside is still there at that bound.
   */
  const insideEmptiesByItsLimit = async (spaceId, started, callsBeforePush) => {
    const bound = started + timing.innerLimitMs + (callsBeforePush + 2) * timing.roundTripMs + 3000;
    for (;;) {
      if ((await inside(spaceId, COUNT_SLEEPERS)).stdout === '0\n') return true;
      if (Date.now() > bound) return false;
      await pause(500);
    }
  };

  /** A space of its own for a test that plants something in it. */
  const freshSpace = async (name) => {
    const own = newSpec(name);
    spaceIds.push(own.id);
    await place.create(own);
    return own;
  };

  beforeAll(async () => {
    ({ place, dispose } = createLiveDockerPlace());
    const host = createTestHost({ ownHome: false });
    ({ repo, g } = makeBait(host));
    codeIn = host.codeIn(place);
    await place.create(spec);
    // The slowest of three round trips of `docker exec` into the space sizes the hanging tests.
    let roundTripMs = 0;
    for (let sample = 0; sample < 3; sample += 1) {
      const sampleStarted = Date.now();
      await place.exec(spec.id, ['/bin/true']);
      roundTripMs = Math.max(roundTripMs, Date.now() - sampleStarted);
    }
    timing = hangTiming(roundTripMs);
    before = hostState(repo);
    result = await codeIn.bringCodeIn({ repository: repo, spaceId: spec.id });
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
    removeTestHosts();
  }, CREATE_TIMEOUT_MS);

  it('brings the bait in: the same status line for line, the exec bit, the identity, and nothing ignored', async () => {
    expect(result.spacePath).toBe(`/spaces/${spec.id}/bait-repo-`);
    expect(result.identityCopied).toEqual({ name: true, email: true });
    expect(await insideRepo(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(shortStatus(g));
    expect(await insideRepo(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main\n');
    expect(await insideRepo(['rev-parse', 'HEAD'])).toBe(`${result.base}\n`);
    expect(await insideRepo(['config', 'user.name'])).toBe('Bait Author\n');
    expect(await insideRepo(['config', 'user.email'])).toBe('bait@example.invalid\n');
    expect((await inside(spec.id, 'stat -c %a "$1/run.sh"', [result.spacePath])).stdout).toBe('755\n');
    const present = await inside(spec.id, 'for f in .env node_modules secret-by-global-ignore.txt; do [ -e "$1/$f" ] && echo "$f"; done; true', [result.spacePath]);
    expect(present.stdout).toBe('');
    expect(unchanged()).toEqual([]);
  });

  it('sends the history afterwards, unshallows the repository, and removes the side repository', async () => {
    expect(await codeIn.sendHistory({ repository: repo, spaceId: spec.id, spacePath: result.spacePath, base: result.base })).toEqual({ status: 'sent' });
    expect(await insideRepo(['rev-list', '--count', 'HEAD'])).toBe(g(['rev-list', '--count', 'HEAD']));
    expect(await insideRepo(['rev-parse', '--is-shallow-repository'])).toBe('false\n');
    expect((await inside(spec.id, '[ -e "$1" ] && echo there; true', [`/spaces/${spec.id}/.openchamber-history.git`])).stdout).toBe('');
    // Nothing the agent sees changed: the same status as before the history came.
    expect(await insideRepo(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(shortStatus(g));
    expect(unchanged()).toEqual([]);
  });

  // The secret is searched for on the host, in what was collected from the space. Sending it into
  // the space as a search pattern would put it there.
  it('puts the ignored .env secret nowhere in the space, files or git objects', async () => {
    // Gzipped on the way out, because the space's HOME holds OpenCode's data and exec output is capped.
    const collect = async (script, args) => {
      const collected = await place.exec(spec.id, ['/bin/sh', '-c', `PATH=/usr/bin:/bin; ${script} | gzip -c | base64 -w 0`, 'sh', ...args], { timeoutMs: 120_000 });
      expect(collected.code).toBe(0);
      return zlib.gunzipSync(Buffer.from(collected.stdout, 'base64'));
    };
    const files = await collect('tar -C / -cf - "${1#/}" home/space', [`/spaces/${spec.id}`]);
    const objects = await collect('git -C "$1" cat-file --batch-all-objects --batch', [result.spacePath]);
    // Controls: an untracked file's text is in the files, and the text of a tracked file the bait
    // deleted is in the objects and not in the compressed files, so the object dump is uncompressed.
    expect(files.includes('untracked travels')).toBe(true);
    expect(objects.includes(OBJECTS_ONLY_TEXT)).toBe(true);
    expect(files.includes(OBJECTS_ONLY_TEXT)).toBe(false);
    expect(files.includes(SECRET)).toBe(false);
    expect(objects.includes(SECRET)).toBe(false);
  });

  it('ends a history push that the space never answers at the host timeout, with no host process left and nothing inside after its limit', async () => {
    const own = await freshSpace('Code in, hanging history');
    const ownResult = await codeIn.bringCodeIn({ repository: repo, spaceId: own.id });
    expect((await inside(own.id, PLANT_HANGING_HOOK)).code).toBe(0);
    const started = Date.now();

    const failure = await codeIn.sendHistory({ repository: repo, spaceId: own.id, spacePath: ownResult.spacePath, base: ownResult.base, timeoutMs: timing.hostTimeoutMs, innerMarginSeconds: timing.innerMarginSeconds }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'history_transfer_failed', details: { cause: 'command_timeout' } });
    // The control: the receiving side really was held inside, and still is, because its limit is later.
    expect(Number((await inside(own.id, COUNT_SLEEPERS)).stdout)).toBeGreaterThan(0);
    expect(await hostProcessesGone(spaceResourceName(own.id, 'space'), started + timing.innerLimitMs)).toBe(true);
    expect(await insideEmptiesByItsLimit(own.id, started, DOCKER_CALLS_BEFORE_HISTORY_PUSH), 'the receiver inside outlived the limit inside the space').toBe(true);
    expect(unchanged()).toEqual([]);
  }, CREATE_TIMEOUT_MS);

  it('removes its host ref and leaves the host repository as it was when the space never answers the code-in push', async () => {
    const own = await freshSpace('Code in, hanging');
    expect((await inside(own.id, PLANT_HANGING_HOOK)).code).toBe(0);
    const started = Date.now();

    const failure = await codeIn.bringCodeIn({ repository: repo, spaceId: own.id, timeoutMs: timing.hostTimeoutMs, innerMarginSeconds: timing.innerMarginSeconds }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_transfer_failed', details: { step: 'the base commit', cause: 'command_timeout' } });
    expect(g(['for-each-ref', `refs/openchamber/spaces/${own.id}/`])).toBe('');
    expect(Number((await inside(own.id, COUNT_SLEEPERS)).stdout)).toBeGreaterThan(0);
    expect(await hostProcessesGone(spaceResourceName(own.id, 'space'), started + timing.innerLimitMs)).toBe(true);
    expect(await insideEmptiesByItsLimit(own.id, started, DOCKER_CALLS_BEFORE_CODE_IN_PUSH), 'the receiver inside outlived the limit inside the space').toBe(true);
    expect(unchanged()).toEqual([]);
  }, CREATE_TIMEOUT_MS);
});
