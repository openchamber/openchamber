import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SCRIPT, AFTER_LOSS_SCRIPT, BOUNDARY_IMAGE, INSIDE_SCRIPT, MATRIX_SCRIPT, PROBES_SCRIPT, PROCESS_SCRIPT, REDIRECT_SCRIPT, SEARCH_SCRIPT, SOCKET_SCRIPT,
} from './test-support/boundary-harness.js';

// Runs only with OPENCHAMBER_TEST_DOCKER=1, like the spaces live suites.
const ENABLED = process.env.OPENCHAMBER_TEST_DOCKER === '1';
const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const fixtureServer = fileURLToPath(new URL('./test-support/stdio-fixture-server.js', import.meta.url));

const run = (args) => new Promise((resolve) => {
  execFile('docker', args, { timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
});

// The repository's ignored scratch folder: a rootless daemon may not see this process's /tmp.
const scratch = fileURLToPath(new URL('../../../../../.tmp/protected-mcp-boundary/', import.meta.url));

/** One disposable container: root installs and administers, the engine account probes. */
async function prove({ mutation = 'none' } = {}) {
  await fs.mkdir(scratch, { recursive: true });
  const work = await fs.mkdtemp(path.join(scratch, 'run-'));
  const harness = path.join(work, 'harness');
  const out = path.join(work, 'out');
  const container = `pmcp-boundary-${path.basename(work)}`;
  await fs.mkdir(harness);
  await fs.mkdir(out, { mode: 0o777 });
  await fs.chmod(out, 0o777);
  await Promise.all([
    fs.writeFile(path.join(harness, 'inside.sh'), INSIDE_SCRIPT, { mode: 0o755 }),
    fs.writeFile(path.join(harness, 'admin.mjs'), ADMIN_SCRIPT),
    fs.writeFile(path.join(harness, 'probes.mjs'), PROBES_SCRIPT),
    fs.writeFile(path.join(harness, 'after-loss.mjs'), AFTER_LOSS_SCRIPT),
    fs.writeFile(path.join(harness, 'search.mjs'), SEARCH_SCRIPT),
    fs.writeFile(path.join(harness, 'socket.mjs'), SOCKET_SCRIPT),
    fs.writeFile(path.join(harness, 'matrix.mjs'), MATRIX_SCRIPT),
    fs.writeFile(path.join(harness, 'process.mjs'), PROCESS_SCRIPT),
    fs.writeFile(path.join(harness, 'redirect.mjs'), REDIRECT_SCRIPT),
    fs.copyFile(fixtureServer, path.join(harness, 'stdio-fixture-server.js')),
    fs.copyFile(new URL('./test-support/admin-socket-client.js', import.meta.url), path.join(harness, 'admin-socket-client.mjs')),
  ]);
  await fs.chmod(harness, 0o755);
  for (const name of await fs.readdir(harness)) await fs.chmod(path.join(harness, name), 0o755);
  const read = async (name) => JSON.parse(await fs.readFile(path.join(out, name), 'utf8'));
  try {
    const result = await run([
    'run', '--rm', '--name', container, '--network', 'none',
    '--env', `MUTATION=${mutation}`,
    '--mount', `type=bind,src=${serverDir},dst=/src/server,readonly`,
    '--mount', `type=bind,src=${harness},dst=/harness,readonly`,
    '--mount', `type=bind,src=${out},dst=/out`,
    BOUNDARY_IMAGE, 'bash', '/harness/inside.sh',
  ]);
    if (result.code !== 0) {
      const log = await fs.readFile(path.join(out, 'inside.log'), 'utf8').catch(() => '');
      throw new Error(`container failed (${result.code}): ${result.stderr.slice(-2000)}\n${log.slice(-4000)}`);
    }
    return {
      result,
      probes: await read(path.join('engine', 'results.json')),
      search: await read('search.json'),
      searchAfter: await read('search-after.json'),
      matrix: await read('matrix.json'),
      matrixAfter: await read('matrix-after.json'),
      redirect: await read('redirect.json'),
      afterLoss: await read('after-loss.json'),
      admin: await read('admin.json'),
      log: await fs.readFile(path.join(out, 'inside.log'), 'utf8').catch(() => ''),
    };
  } finally {
    await run(['rm', '-f', container]);
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

describe.skipIf(!ENABLED)('protected MCP boundary between real Linux accounts', () => {
  it('serves authorized calls and redacted administration while enforcing the account boundary', async () => {
    // Given the real installer and distinct Linux identities, when they probe the broker:
    const { probes, search, searchAfter, afterLoss, admin, log, matrix: { matrix, permissions, service }, redirect } = await prove();
    // Then each group grants only its socket, with a working allowed control.
    for (const [user, kind] of [['outsider', 'engine'], ['outsider', 'admin'], ['clientonly', 'admin'], ['adminonly', 'engine']]) {
      expect(matrix[user][kind], `${user}/${kind}`).toEqual({ allowed: false, code: 'EACCES' });
    }
    for (const user of ['clientonly', 'engine']) {
      expect(matrix[user].engine.allowed).toBe(true);
      expect(matrix[user].engine.answer.administration).toBe('shared');
    }
    for (const user of ['adminonly', 'engine']) {
      expect(matrix[user].admin.allowed).toBe(true);
      expect(matrix[user].admin.answer.type).toBe('connections');
    }
    expect(matrix.outsider.groups).toEqual(['outsider']);
    expect(matrix.clientonly.groups).toEqual(['clientonly', 'openchamber-mcp-clients']);
    expect(matrix.adminonly.groups).toEqual(['adminonly', 'openchamber-mcp-admins']);
    expect(matrix.engine.groups).toEqual(expect.arrayContaining(['openchamber-mcp-clients', 'openchamber-mcp-admins']));
    expect(permissions).toEqual({
      '/run/openchamber-protected-mcp': 'openchamber-mcp:openchamber-mcp-clients 750',
      '/run/openchamber-protected-mcp/engine.sock': 'openchamber-mcp:openchamber-mcp-clients 660',
      '/run/openchamber-protected-mcp-admin': 'openchamber-mcp:openchamber-mcp-admins 750',
      '/run/openchamber-protected-mcp-admin/admin.sock': 'openchamber-mcp:openchamber-mcp-admins 660',
    });
    expect(service).toMatchObject({ running: true, enterpriseMode: true, networkAccessUnset: true });
    expect(service.tcp.controlListening.length).toBeGreaterThan(0);
    expect(service.tcp.serviceSockets.length).toBeGreaterThan(0);
    expect(service.tcp.serviceListening).toEqual([]);
    expect(probes.administration).toBe('shared');
    expect(probes.admin_list).toBe('connections');
    expect(probes.admin_get).toBe('connection');
    expect(redirect).toEqual({ refused: 'credential_rebind_required', unchanged: true, accepted: 'applied', environment: [{ type: 'text', text: 'engine-typed-value' }] });
    expect(searchAfter.hits).toEqual([]);
    expect(admin.id, log).toMatch(/^pmcp_[0-9a-f]{16}$/);
    // The positive control: the authorized call works and the worker got its credential.
    expect(probes.relay_whoami).toBe('credential matches');
    expect(probes.worker_pids).toBeGreaterThan(0);
    // Reads and process introspection.
    for (const name of ['read_state_dir', 'read_state.json', 'read_credentials_dir']) {
      expect(probes[name], name).toEqual({ allowed: false, code: 'EACCES' });
    }
    for (const [name, outcome] of Object.entries(probes)) {
      if (/^(environ|mem|worker_environ)_/.test(name)) expect(outcome, name).toMatchObject({ allowed: false });
    }
    // Writes to code, configuration, trusted runtimes and state.
    for (const name of ['write_service_code', 'write_service_config', 'write_fixture_runtime', 'write_worker_path_binary', 'replace_current_symlink', 'write_state_dir']) {
      expect(probes[name], name).toMatchObject({ allowed: false });
    }
    // No administration on the engine socket.
    for (const type of ['create', 'update', 'export', 'getCredential', 'approve']) {
      expect(probes[`socket_${type}`]).toBe('{"type":"error","code":"unsupported_request"}');
    }
    // The service's own check finds nothing wrong; without getfacl in the image it cannot say more than unverified.
    expect(probes.status_enforcement).toBe('unverified');
    // Nothing the engine collected holds the credential, which the protected state does hold.
    for (const root of ['/etc/openchamber', '/usr/lib/openchamber-protected-mcp', '/var/lib']) {
      expect(probes.collected[root], root).toBeGreaterThan(0);
    }
    expect(search.controlFoundInProtectedState).toBe(true);
    expect(search.filesSearched).toBeGreaterThan(20);
    expect(search.hits).toEqual([]);
    // Service loss fails closed, fast.
    expect(afterLoss.exit).toBe(69);
    expect(afterLoss.ms).toBeLessThan(5000);
  }, 5 * 60_000);

  it('goes red when the state directory is opened to the engine', async () => {
    const { probes, search } = await prove({ mutation: 'state-readable' });
    expect(probes.read_state_dir.allowed).toBe(true);
    expect(search.hits.length).toBeGreaterThan(0);
  }, 5 * 60_000);

  it('reports the boundary unprotected when the installed code is writable', async () => {
    const { probes } = await prove({ mutation: 'code-writable' });
    expect(probes.status_enforcement).toBe('unprotected');
    expect(probes.write_service_code.allowed).toBe(true);
  }, 5 * 60_000);

  it('allows the outsider admin probe when the admin socket boundary is opened', async () => {
    // Given a protected socket, when both its directory and socket permissions are opened:
    const { matrix, matrixAfter } = await prove({ mutation: 'admin-socket-open' });
    // Then the identical outsider request changes from EACCES to a real list answer.
    expect(matrix.matrix.outsider.admin).toEqual({ allowed: false, code: 'EACCES' });
    expect(matrixAfter.matrix.outsider.admin).toMatchObject({ allowed: true, answer: { type: 'connections' } });
    expect(matrixAfter.matrix.outsider.engine).toEqual({ allowed: false, code: 'EACCES' });
  }, 5 * 60_000);
});
