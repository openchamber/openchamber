import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopEmbeddedServer } from './server-shutdown.mjs';

test('waits for backend-owned children before allowing Electron to exit', async () => {
  let release;
  let stopped = false;
  let options;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const stopping = stopEmbeddedServer({ stop(input) { options = input; return cleanup; } }, {
    launchFallback() { assert.fail('normal shutdown must not launch another process'); },
    warn() { assert.fail('normal shutdown must succeed'); },
  }).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(options, { exitProcess: false });
  release();
  await stopping;
  assert.equal(stopped, true);
});

for (const failure of ['error', 'deadline']) {
  test(`uses the current managed process for fallback on ${failure}`, async () => {
    const warnings = [];
    const kills = [];
    const info = { managed: true, pid: 123, port: 45678 };
    await stopEmbeddedServer({
      stop: () => failure === 'error' ? Promise.reject(new Error('fixture')) : new Promise(() => {}),
      getOpenCodeProcessInfo: () => info,
    }, { timeoutMs: 10, launchFallback: (value) => kills.push(value), warn: (error) => warnings.push(error) });
    assert.equal(warnings.length, 1);
    assert.deepEqual(kills, [info]);
  });
}

test('remote-only Desktop has no local backend to stop', async () => {
  await stopEmbeddedServer(null, {
    launchFallback() { assert.fail('external OpenCode is not owned by Desktop'); },
    warn() { assert.fail('missing local backend is normal'); },
  });
});
