import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDefinition } from './definitions.js';
import { cli, compareTools, migrate, parseManifest, readEnvironmentValue, rollbackMigration } from './migrate.js';
import { openStore } from './store.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = 'synthetic-migration-token-8c41';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-mcp-migrate-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, 'github.env');
  // The way dev-server writes a broker's EnvironmentFile: to_json quoting.
  await fs.writeFile(envFile, `GITHUB_PERSONAL_ACCESS_TOKEN=${JSON.stringify(SECRET)}\n`, { mode: 0o600 });
  const manifest = {
    version: 1,
    connections: [
      {
        id: 'pmcp_00000000000000a1',
        source: 'dev-server:precocerto/github',
        definition: {
          name: 'precocerto-github',
          transport: 'stdio',
          stdio: { command: '/usr/local/bin/github-mcp-server', args: ['stdio', '--toolsets', 'repos,issues,pull_requests,actions,code_security'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token' } } },
        },
        credentials: { token: { envFile, key: 'GITHUB_PERSONAL_ACCESS_TOKEN' } },
        expectedTools: ['get_me', 'list_issues'],
      },
      {
        id: 'pmcp_00000000000000a2',
        source: 'dev-server:precocerto/harness',
        definition: {
          name: 'precocerto-harness',
          transport: 'http',
          http: { url: 'https://mcp.harness.io/mcp', oauth: { scopes: ['openid', 'offline_access'], clientId: 'mcp-client' } },
          policy: { denyTools: ['harness_create', 'harness_update', 'harness_delete', 'harness_execute'] },
        },
      },
    ],
    selections: [{ scope: 'project', project: '/home/dev/workspace/precocerto', name: 'github', connection: 'pmcp_00000000000000a1' }],
  };
  return { root, stateDir: path.join(root, 'state'), envFile, manifest };
}

/** Every path under `root` with its mode and, for files, its content. */
async function snapshot(root) {
  const entries = [['.', (await fs.lstat(root)).mode, null]];
  const walk = async (directory) => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const full = path.join(directory, name);
      const stats = await fs.lstat(full);
      entries.push([path.relative(root, full), stats.mode, stats.isFile() ? await fs.readFile(full, 'utf8') : null]);
      if (stats.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return entries;
}

describe('migration into the protected service', () => {
  it('reads dev-server environment files the way systemd does', () => {
    expect(readEnvironmentValue(`A=1\nTOKEN=${JSON.stringify('va"lue$x')}\n`, 'TOKEN')).toBe('va"lue$x');
    expect(readEnvironmentValue('TOKEN=plain\n', 'TOKEN')).toBe('plain');
    expect(readEnvironmentValue('OTHER=1\n', 'TOKEN')).toBeNull();
  });

  it('dry-runs without writing, then creates connections with their policies and credentials', async () => {
    const { stateDir, manifest } = await fixture();
    const parsed = parseManifest(manifest);
    const dry = await migrate({ stateDir, manifest: parsed, dryRun: true });
    expect(dry.report.map((line) => line.action)).toEqual(['would-create', 'would-create']);
    expect(JSON.stringify(dry)).not.toContain(SECRET);

    const applied = await migrate({ stateDir, manifest: parsed });
    expect(applied.report.map((line) => [line.name, line.action, line.credentials])).toEqual([
      ['precocerto-github', 'created', ['token']],
      ['precocerto-harness', 'created', []],
    ]);
    expect(JSON.stringify(applied)).not.toContain(SECRET);
    const store = await openStore({ stateDir });
    try {
      const github = store.get('pmcp_00000000000000a1');
      expect(store.credentialsFor(github).secrets.token).toBe(SECRET);
      expect(store.credentialState(store.get('pmcp_00000000000000a2'))).toBe('authorization_required');
      expect(store.get('pmcp_00000000000000a2').policy.denyTools).toContain('harness_execute');
    } finally {
      await store.close();
    }

    const again = await migrate({ stateDir, manifest: parsed });
    expect(again.report.map((line) => line.action)).toEqual(['present', 'present']);
  });

  it('gives the state back to its owner after a real run as root, and touches nothing after a dry run', async () => {
    const { root, stateDir, manifest } = await fixture();
    await fs.mkdir(stateDir, { mode: 0o700 });
    const manifestFile = path.join(root, 'manifest.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const restored = [];
    const asRoot = { getuid: () => 0, restore: async (directory) => { restored.push(directory); } };
    const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cli(['apply', '--state', stateDir, '--manifest', manifestFile, '--dry-run'], asRoot)).toBe(0);
      expect(restored).toEqual([]);
      expect(await cli(['apply', '--state', stateDir, '--manifest', manifestFile], asRoot)).toBe(0);
      expect(restored).toEqual([stateDir]);
    } finally {
      quiet.mockRestore();
    }
  });

  it('writes nothing in a dry run, not even what opening the state would tidy up', async () => {
    const { stateDir, manifest } = await fixture();
    const parsed = parseManifest(manifest);
    await migrate({ stateDir, manifest: parsed, dryRun: true });
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await migrate({ stateDir, manifest: parsed });
    // Opening the store deletes an orphan credential file and makes directories 0700.
    await fs.writeFile(path.join(stateDir, 'credentials', 'pmcp_ffffffffffffffff.json'), '{}', { mode: 0o600 });
    await fs.chmod(path.join(stateDir, 'migrations'), 0o750);
    const before = await snapshot(stateDir);
    const dry = await migrate({ stateDir, manifest: parsed, dryRun: true });
    expect(dry.report.map((line) => line.action)).toEqual(['present', 'present']);
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it('refuses a manifest that would broaden a policy or redirect an existing connection', async () => {
    const { stateDir, manifest } = await fixture();
    await migrate({ stateDir, manifest: parseManifest(manifest) });
    const broadened = structuredClone(manifest);
    broadened.connections[1].definition.policy = { denyTools: [] };
    await expect(migrate({ stateDir, manifest: parseManifest(broadened) })).rejects.toMatchObject({ code: 'conflicting_connection' });
    const redirected = structuredClone(manifest);
    redirected.connections[0].definition.stdio.args = ['stdio'];
    await expect(migrate({ stateDir, manifest: parseManifest(redirected) })).rejects.toMatchObject({ code: 'conflicting_connection' });
    expect(() => parseManifest({ ...manifest, connections: [{ ...manifest.connections[0], credentials: {} }] })).toThrow();
  });

  it('writes nothing when a credential is missing, and resumes after an interruption', async () => {
    const { stateDir, manifest, envFile } = await fixture();
    await fs.writeFile(envFile, 'OTHER=1\n');
    await expect(migrate({ stateDir, manifest: parseManifest(manifest) })).rejects.toMatchObject({ code: 'credential_missing' });
    await expect(fs.readFile(path.join(stateDir, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(envFile, `GITHUB_PERSONAL_ACCESS_TOKEN=${JSON.stringify(SECRET)}\n`);
    let calls = 0;
    const interrupted = (from) => {
      calls += 1;
      return fs.readFile(from.envFile, 'utf8').then((text) => readEnvironmentValue(text, from.key));
    };
    // The first connection lands, then the run dies before the second.
    const first = parseManifest({ ...manifest, connections: [manifest.connections[0]] });
    await migrate({ stateDir, manifest: first, readCredentialValue: interrupted });
    const resumed = await migrate({ stateDir, manifest: parseManifest(manifest), readCredentialValue: interrupted });
    expect(resumed.report.map((line) => line.action)).toEqual(['present', 'created']);
    expect(calls).toBe(2);
  });

  it('rolls back exactly what it created and leaves other connections alone', async () => {
    const { stateDir, manifest } = await fixture();
    const store = await openStore({ stateDir });
    await store.apply({ kind: 'create', definition: parseDefinition({ name: 'kept', transport: 'http', http: { url: 'https://kept.example.com/mcp' } }), secrets: {} });
    await store.close();
    await migrate({ stateDir, manifest: parseManifest(manifest) });
    const { removed } = await rollbackMigration({ stateDir });
    expect(removed).toEqual(['pmcp_00000000000000a2', 'pmcp_00000000000000a1']);
    const after = await openStore({ stateDir });
    try {
      expect(after.list().map(({ definition }) => definition.name)).toEqual(['kept']);
    } finally {
      await after.close();
    }
  });

  it('refuses to run while the service owns the state', async () => {
    const { stateDir, manifest } = await fixture();
    const running = await openStore({ stateDir });
    try {
      await expect(migrate({ stateDir, manifest: parseManifest(manifest) })).rejects.toMatchObject({ code: 'state_locked' });
    } finally {
      await running.close();
    }
  });

  it('copies token caches into the worker directory and refuses paths that climb out of it', async () => {
    const { root, stateDir, manifest } = await fixture();
    const cache = path.join(root, 'token-cache.json');
    await fs.writeFile(cache, '{"synthetic":"cache"}', { mode: 0o600 });
    const withCache = structuredClone(manifest);
    withCache.connections[1].stateFiles = [{ from: cache, to: 'cache/token-cache.json' }];
    await migrate({ stateDir, manifest: parseManifest(withCache) });
    const copied = path.join(stateDir, 'connections', 'pmcp_00000000000000a2', 'cache', 'token-cache.json');
    expect(await fs.readFile(copied, 'utf8')).toBe('{"synthetic":"cache"}');
    expect((await fs.stat(copied)).mode & 0o077).toBe(0);
    const escaping = structuredClone(manifest);
    escaping.connections[1].stateFiles = [{ from: cache, to: '../../admin.json' }];
    expect(() => parseManifest(escaping)).toThrow();
  });

  it('finishes a connection whose state files were not all copied when an earlier run stopped', async () => {
    const { root, stateDir, manifest } = await fixture();
    const first = path.join(root, 'cache-one.json');
    const second = path.join(root, 'cache-two.json');
    await fs.writeFile(first, '{"one":1}', { mode: 0o600 });
    await fs.writeFile(second, '{"two":2}', { mode: 0o600 });
    const withCaches = structuredClone(manifest);
    withCaches.connections[1].stateFiles = [{ from: first, to: 'one.json' }, { from: second, to: 'two.json' }];
    const parsed = parseManifest(withCaches);
    let reads = 0;
    // The machine goes down after the definition and the first cache are written.
    const crashing = async (file) => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error('power cut'), { code: 'EIO' });
      return fs.readFile(file);
    };
    await expect(migrate({ stateDir, manifest: parsed, readStateFile: crashing })).rejects.toThrow('power cut');
    const directory = path.join(stateDir, 'connections', 'pmcp_00000000000000a2');
    expect(await fs.readFile(path.join(directory, 'one.json'), 'utf8')).toBe('{"one":1}');
    await expect(fs.readFile(path.join(directory, 'two.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const dry = await migrate({ stateDir, manifest: parsed, dryRun: true });
    expect(dry.report.map((line) => line.action)).toEqual(['present', 'would-resume']);
    const resumed = await migrate({ stateDir, manifest: parsed });
    expect(resumed.report.map((line) => line.action)).toEqual(['present', 'resumed']);
    expect(await fs.readFile(path.join(directory, 'two.json'), 'utf8')).toBe('{"two":2}');
    expect((await migrate({ stateDir, manifest: parsed })).report.map((line) => line.action)).toEqual(['present', 'present']);
    expect((await rollbackMigration({ stateDir })).removed).toEqual(['pmcp_00000000000000a2', 'pmcp_00000000000000a1']);
  });

  it('leaves a connection it did not create alone, even when its state files are missing', async () => {
    const { root, stateDir, manifest } = await fixture();
    const cache = path.join(root, 'cache.json');
    await fs.writeFile(cache, '{}', { mode: 0o600 });
    const store = await openStore({ stateDir });
    await store.apply({ kind: 'create', definition: parseDefinition(manifest.connections[1].definition), secrets: {} }, { id: manifest.connections[1].id });
    await store.close();
    const withCache = structuredClone(manifest);
    withCache.connections[1].stateFiles = [{ from: cache, to: 'cache.json' }];
    const result = await migrate({ stateDir, manifest: parseManifest(withCache) });
    expect(result.report.map((line) => line.action)).toEqual(['created', 'present']);
    await expect(fs.readFile(path.join(stateDir, 'connections', manifest.connections[1].id, 'cache.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await rollbackMigration({ stateDir })).removed).toEqual([manifest.connections[0].id]);
  });

  it('compares tool inventories before and after', () => {
    expect(compareTools({ expected: ['a', 'b', 'c'], actual: ['b', 'c', 'd'] })).toEqual({ missing: ['a'], added: ['d'] });
  });
});
