/**
 * The bug behind the quota endpoints' `UnexpectedStatus: 500` was a join of
 * two owners: the credential read (auth.js) scopes its supplementary
 * integration read to `getDefaultDirectory()`, and the lifecycle (lifecycle.js)
 * handed back a directory cached at startup forever. Once that directory
 * stopped being resolvable, `/api/integration` answered
 * `500 FileSystem.realPath ... ENOENT` and `Promise.all` turned the optional
 * env-key read into a failure of the whole credential read — so
 * `/api/quota/providers` answered 500 and every `/api/quota/<provider>` looked
 * like "OpenCode cannot be asked".
 *
 * This suite composes the two real modules, not a stand-in for either: the
 * lifecycle runtime supplies the directory, `openCodeCredentialSource` reads
 * through it, and a fake OpenCode answers the way the real one does — a
 * directory-scoped integration read succeeds only while the directory in the
 * `x-opencode-directory` header is resolvable, and answers
 * `500 FileSystem.realPath` otherwise. That keeps the semantic correspondence
 * the regression depends on: the read is broken by the header it is sent, not
 * by a test switch.
 *
 * Acceptance covered:
 *  - a stale cached default must not break the authoritative credential read;
 *  - a still-valid default still scopes the read (an env-var provider stays
 *    configured);
 *  - a genuine `/api/credential` failure must still reject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { configureOpenCodeCredentials, openCodeCredentialSource, readOpenCodeCredentials } from './auth.js';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';

const createLifecycleRuntime = (warmupDirectories) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };
  return createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: true,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    checkOpenCodeBinary: async () => '2.0.23',
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/usr/bin'),
    topUpV1SessionMigration: vi.fn(() => ({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' })),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({ PATH: '/usr/bin' })),
    reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    getWarmupDirectories: vi.fn(async () => warmupDirectories),
  });
};

const credentialEntry = (integrationID, value) => ({
  id: `cred_${integrationID}`,
  integrationID,
  label: 'default',
  active: true,
  value,
});

const originalFetch = globalThis.fetch;

describe('credential read through the lifecycle default directory', () => {
  let server;
  let root;
  let stale;
  let lifecycle;
  let credentialFails;
  let credentialReads;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-cred-'));
    stale = path.join(root, 'last-used');
    await fsp.mkdir(stale);
    credentialFails = false;
    credentialReads = 0;

    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/credential')) {
        credentialReads += 1;
        if (credentialFails) {
          res.statusCode = 500;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ data: [credentialEntry('deepseek', { type: 'key', key: 'ds' })] }));
        return;
      }
      if (req.url.startsWith('/api/integration')) {
        // Mirror the real OpenCode: a location-scoped read of an unresolvable
        // directory answers 500 FileSystem.realPath.
        const header = req.headers['x-opencode-directory'];
        if (header !== undefined) {
          const directory = decodeURIComponent(header);
          let usable = false;
          try {
            usable = fs.statSync(directory).isDirectory();
          } catch {
            usable = false;
          }
          if (!usable) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'FileSystem.realPath' }));
            return;
          }
        }
        res.end(JSON.stringify({
          data: [{ id: 'zai-coding-plan', connections: [{ type: 'env', name: 'ZHIPU_API_KEY' }] }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    lifecycle = createLifecycleRuntime([stale]);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.0.23', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    await lifecycle.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The lifecycle only needs the stub while it bootstraps; `@opencode/client`
    // (used by the credential source) makes real HTTP calls to the fake
    // OpenCode above, so restore the real fetch before any credential read.
    globalThis.fetch = originalFetch;

    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${port}${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      getLaunchEnvironment: () => ({ ZHIPU_API_KEY: 'zk' }),
      getDefaultDirectory: () => lifecycle.getDefaultOpenCodeDirectory(),
    }));
  });

  afterEach(async () => {
    configureOpenCodeCredentials(null);
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('still reads credentials when the cached default directory has gone stale', async () => {
    // While the directory is valid, its env-var provider is reported.
    await expect(readOpenCodeCredentials()).resolves.toEqual({
      deepseek: { type: 'api', key: 'ds' },
      'zai-coding-plan': { type: 'api', key: 'zk' },
    });

    // The directory disappears, as when the user deletes or moves the
    // project. The scoped integration read would 500 if the stale path were
    // still sent; the credential read must not be taken down with it.
    await fsp.rm(stale, { recursive: true, force: true });

    // Before the fix this rejected (the 500 on the stale integration read took
    // the whole read down); now the stored credential is read regardless.
    await expect(readOpenCodeCredentials()).resolves.toMatchObject({
      deepseek: { type: 'api', key: 'ds' },
    });
    // The stale path was never sent: the read falls back to OpenCode's own
    // working directory rather than a header that only fails.
    expect(lifecycle.getDefaultOpenCodeDirectory()).toBeNull();
  });

  it('still rejects when OpenCode cannot answer the authoritative credential read', async () => {
    await fsp.rm(stale, { recursive: true, force: true });
    credentialFails = true;
    // Even with a stale default directory, a real `/api/credential` failure is
    // authoritative and must still reject — it must never look like "no keys".
    await expect(readOpenCodeCredentials()).rejects.toThrow();
    expect(credentialReads).toBeGreaterThan(0);
  });
});
