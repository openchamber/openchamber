import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The import reads the Cursor database under os.homedir(), and the test
// runner's runtime resolves homedir from the environment it starts with, so
// each case runs the real import in a child process whose HOME is the fake
// home. The child also stubs the darwin platform gate before calling it.
import { normalizeCredential, validateCredential, OPEN_DESIGN_API_BASE_URL, OPEN_DESIGN_SESSION_EXPIRED_ERROR } from './quotaCredentials';

const modulePath = fileURLToPath(new URL('./quotaCredentials.ts', import.meta.url));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const runImport = (sqliteScript: string, timeoutMs: number) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-cursor-import-'));
  directories.push(home);
  const dbDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(dbDir, 'state.vscdb'), '');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const sqlite = path.join(binDir, 'sqlite3');
  fs.writeFileSync(sqlite, sqliteScript);
  fs.chmodSync(sqlite, 0o755);
  const driver = path.join(home, 'driver.ts');
  fs.writeFileSync(driver, [
    `Object.defineProperty(process, 'platform', { value: 'darwin' });`,
    `const { importCursorCredential } = await import(${JSON.stringify(modulePath)});`,
    `try {`,
    `  const credential = importCursorCredential({ timeoutMs: ${timeoutMs} });`,
    `  console.log('OK ' + JSON.stringify(credential));`,
    `} catch (error) {`,
    `  console.log('ERR ' + (error instanceof Error ? error.message : String(error)));`,
    `}`,
    ``,
  ].join('\n'));

  const startedAt = Date.now();
  const output = execFileSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });
  return { output: output.trim(), elapsed: Date.now() - startedAt };
};

test('Cursor credential import gives up on a hung sqlite3 within the timeout', () => {
  const { output, elapsed } = runImport('#!/bin/sh\nwhile :; do :; done\n', 250);

  assert.ok(output.startsWith('ERR '), `expected the import to fail, got: ${output}`);
  assert.ok(elapsed < 5_000, `expected settlement within the timeout, took ${elapsed}ms`);
});

test('Cursor credential import returns the stored tokens when sqlite3 answers promptly', () => {
  const rows = JSON.stringify([
    { key: 'cursorAuth/accessToken', value: 'access-token' },
    { key: 'cursorAuth/refreshToken', value: 'refresh-token' },
  ]);
  const { output } = runImport(`#!/bin/sh\nprintf '%s' '${rows}'\n`, 5_000);

  assert.ok(output.startsWith('OK '), `expected the import to succeed, got: ${output}`);
  assert.deepEqual(JSON.parse(output.slice(3)), { accessToken: 'access-token', refreshToken: 'refresh-token' });
});

test('normalizeCredential: opendesign wraps a bare session token and requires a workspace id', () => {
  assert.deepEqual(
    normalizeCredential('opendesign', { cookie: 'tok123', workspaceId: 'ws_1' }),
    { cookie: 'better-auth.session_token=tok123', workspaceId: 'ws_1' },
  );
  assert.deepEqual(
    normalizeCredential('opendesign', { cookie: 'better-auth.session_token=tok123', workspaceId: 'ws_1' }),
    { cookie: 'better-auth.session_token=tok123', workspaceId: 'ws_1' },
  );
  assert.equal(normalizeCredential('opendesign', { cookie: 'tok123' }), null);
  assert.equal(normalizeCredential('opendesign', { workspaceId: 'ws_1' }), null);
  assert.equal(normalizeCredential('opendesign', { cookie: 'tok\n123', workspaceId: 'ws_1' }), null);
});

// validateCredential's opendesign branch: the session probe mirrors the
// quota fetcher — GET ${OPEN_DESIGN_API_BASE_URL}/auth/get-session with the
// workspace header; any non-object session is an expired session.
const openDesignCredential = { cookie: 'better-auth.session_token=token-value', workspaceId: 'ws-1' };

const sessionFetch = (respond: () => Response, calls: { url: string; init: RequestInit }[]) =>
  async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };

test('validateCredential opendesign: a valid session object passes and probes get-session', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = sessionFetch(() => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }), calls);
  await validateCredential('opendesign', openDesignCredential, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${OPEN_DESIGN_API_BASE_URL}/auth/get-session`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-vela-workspace-id'], 'ws-1');
  assert.equal(headers.Cookie, openDesignCredential.cookie);
});

test('validateCredential opendesign: a non-object session throws the expired-session error', async () => {
  for (const body of ['null', '"ok"', '42']) {
    const fetchImpl = sessionFetch(() => new Response(body, { status: 200 }), []);
    await assert.rejects(
      validateCredential('opendesign', openDesignCredential, fetchImpl),
      (error: Error) => error.message === OPEN_DESIGN_SESSION_EXPIRED_ERROR
    );
  }
});

test('validateCredential opendesign: an HTTP error session probe throws the expired-session error', async () => {
  const fetchImpl = sessionFetch(() => new Response('nope', { status: 401 }), []);
  await assert.rejects(
    validateCredential('opendesign', openDesignCredential, fetchImpl),
    (error: Error) => error.message === OPEN_DESIGN_SESSION_EXPIRED_ERROR
  );
});

test('validateCredential opendesign: missing cookie or workspace is rejected before any fetch', async () => {
  const fetchImpl = sessionFetch(() => { throw new Error('must not fetch'); }, []);
  await assert.rejects(validateCredential('opendesign', { workspaceId: 'ws-1' }, fetchImpl), /cookie is required/);
  await assert.rejects(validateCredential('opendesign', { cookie: 'better-auth.session_token=t' }, fetchImpl), /workspace ID is required/);
});
