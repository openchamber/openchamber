import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import {
  OPEN_IN_APP_SPAWN_TIMEOUT_MS,
  SW_VERS_SPAWN_TIMEOUT_MS,
  WHERE_SPAWN_TIMEOUT_MS,
  WINDOWS_TERMINAL_PACKAGE_SPAWN_TIMEOUT_MS,
} from './spawn-sync-timeouts.mjs';

const TIMEOUTS = {
  SW_VERS_SPAWN_TIMEOUT_MS,
  WHERE_SPAWN_TIMEOUT_MS,
  WINDOWS_TERMINAL_PACKAGE_SPAWN_TIMEOUT_MS,
  OPEN_IN_APP_SPAWN_TIMEOUT_MS,
};

test('every named spawnSync timeout is in the tree probe range (1.5-10s)', () => {
  for (const [name, value] of Object.entries(TIMEOUTS)) {
    assert.ok(Number.isInteger(value) && value >= 1_500 && value <= 10_000, `${name}=${value}`);
  }
});

test('every production spawnSync in early-startup.mjs and main.mjs passes a timeout', () => {
  for (const file of ['early-startup.mjs', 'main.mjs']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/spawnSync\(/g)];
    assert.ok(calls.length > 0, `${file}: expected spawnSync calls`);
    for (const call of calls) {
      const options = source.slice(call.index, call.index + 400);
      assert.match(options, /timeout:/, `${file}: spawnSync at offset ${call.index} has no timeout`);
    }
  }
});

test('each #833 site passes its named timeout constant', () => {
  const earlyStartup = fs.readFileSync(new URL('./early-startup.mjs', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(earlyStartup, /timeout: SW_VERS_SPAWN_TIMEOUT_MS/);
  assert.match(main, /timeout: WHERE_SPAWN_TIMEOUT_MS/);
  assert.match(main, /timeout: WINDOWS_TERMINAL_PACKAGE_SPAWN_TIMEOUT_MS/);
  assert.match(main, /timeout: OPEN_IN_APP_SPAWN_TIMEOUT_MS/);
});

test('a hanging child settles as ETIMEDOUT instead of blocking forever', () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    encoding: 'utf8',
    timeout: 100,
  });
  assert.ok(Date.now() - started < 5_000, 'call must settle near the timeout, not the child life');
  assert.equal(result.error?.code, 'ETIMEDOUT');
});

test('a promptly answering child is unchanged by the timeout option', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("26.1")'], {
    encoding: 'utf8',
    timeout: SW_VERS_SPAWN_TIMEOUT_MS,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '26.1');
});
