import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { SENTINEL, installStdioFixture, sha256, startService, trustedFixtureDirectory } from '../test-support/fixtures.js';

const relay = fileURLToPath(new URL('./relay.js', import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The relay as OpenCode starts it: a child process speaking MCP on stdio. */
function startRelay(args) {
  const child = spawn(process.execPath, [relay, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      value = { text: line };
    }
    lines.push(value);
    while (waiters.length > 0 && lines.length > 0) waiters.shift()(lines.shift());
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    next: () => new Promise((resolve) => {
      if (lines.length > 0) resolve(lines.shift());
      else waiters.push(resolve);
    }),
    end: () => child.stdin.end(),
    exited,
    get stderr() { return stderr; },
  };
}

async function connection() {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const fixture = await startService();
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const created = await admin.apply({
    kind: 'create',
    definition: {
      name: 'fixture',
      transport: 'stdio',
      stdio: { command: await installStdioFixture(scratch.directory), env: { TOKEN: { secret: 'token' }, EXPECTED_TOKEN_SHA256: sha256(SENTINEL) } },
    },
    secrets: { token: SENTINEL },
  });
  return { fixture, admin, connection: created.connection };
}

describe('relay process', () => {
  it('carries a whole MCP session over stdio and exits cleanly when the client ends', async () => {
    const { fixture, connection: target } = await connection();
    const client = startRelay(['--socket', fixture.engineSocketPath, target.id]);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect((await client.next()).result.serverInfo.name).toBe('stdio-fixture');
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const answer = await client.next();
    expect(answer.result.content[0].text).toBe('credential matches');
    client.end();
    expect(await client.exited).toBe(0);
    expect(client.stderr).toBe('');
    expect(JSON.stringify(answer) + client.stderr).not.toContain(SENTINEL);
  });

  it('prints help, refuses bad arguments and fails fast without a service', async () => {
    const help = startRelay(['--help']);
    expect(await help.exited).toBe(0);
    for (const args of [[], ['pmcp_0123456789abcdef'], ['--socket', '/x'], ['--socket', '/x', 'github']]) {
      const bad = startRelay(args);
      expect(await bad.exited).toBe(64);
      expect(bad.stderr).toContain('Usage:');
    }
    const started = Date.now();
    const missing = startRelay(['--socket', path.join(path.dirname(relay), 'no-such.sock'), 'pmcp_0123456789abcdef']);
    expect(await missing.exited).toBe(69);
    expect(missing.stderr).toContain('not reachable');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a refused connection and a session the service ended', async () => {
    const { fixture, admin, connection: target } = await connection();
    const unknown = startRelay(['--socket', fixture.engineSocketPath, 'pmcp_ffffffffffffffff']);
    expect(await unknown.exited).toBe(69);
    expect(unknown.stderr).toContain('the service has no such connection');

    const client = startRelay(['--socket', fixture.engineSocketPath, target.id]);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await client.next();
    await admin.apply({ kind: 'set-enabled', id: target.id, expectedRevision: target.revision, enabled: false });
    expect(await client.exited).toBe(75);
    expect(client.stderr).toContain('ended the session');
  });
});
