import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketClient } from '../test-support/admin-socket-client.js';
import {
  SENTINEL, engineRequest, engineSession, installStdioFixture, sha256, startService, trustedFixtureDirectory,
} from '../test-support/fixtures.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup({ env = {}, policy } = {}) {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const command = await installStdioFixture(scratch.directory);
  const fixture = await startService();
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const definition = {
    name: 'fixture',
    transport: 'stdio',
    stdio: { command, args: [], env: { TOKEN: { secret: 'token' }, EXPECTED_TOKEN_SHA256: sha256(SENTINEL), ...env } },
    policy: policy ?? { denyTools: ['delete_everything'] },
  };
  const created = await admin.apply({ kind: 'create', definition, secrets: { token: SENTINEL } });
  expect(created.type).toBe('applied');
  return { fixture, admin, connection: created.connection, command, scratch, definition };
}

const initialize = async (session) => {
  session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const { message } = await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return message;
};

describe('protected stdio sessions', () => {
  it('fills default arguments only where the tool declares them and never over what the agent gave', async () => {
    const { fixture, connection } = await setup({ policy: { defaultArguments: { org_id: 'acme', project_id: 'web' } } });
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    await initialize(session);
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await session.response(2);
    session.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo_args', arguments: { query: 'x' } } });
    expect(JSON.parse((await session.response(3)).message.result.content[0].text)).toEqual({ query: 'x', org_id: 'acme' });
    session.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo_args', arguments: { org_id: 'other' } } });
    expect(JSON.parse((await session.response(4)).message.result.content[0].text)).toEqual({ org_id: 'other' });
    await session.close();
  });

  it('refuses a path argument the engine could change, such as an interpreter script', async () => {
    const scratch = await trustedFixtureDirectory();
    cleanups.push(scratch.remove);
    const writable = path.join(scratch.directory, 'open');
    await fs.mkdir(writable);
    await fs.chmod(writable, 0o777);
    const script = path.join(writable, 'script.js');
    await fs.writeFile(script, '');
    const { fixture, admin, connection, definition } = await setup();
    const changed = await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: connection.revision,
      definition: { ...definition, stdio: { ...definition.stdio, args: [script] } }, secrets: { token: SENTINEL },
    });
    expect(changed.type).toBe('applied');
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    expect((await initialize(session)).result.instructions).toContain('untrusted_argument');
    await session.close();
  });

  it('refuses a missing path argument where the engine could create it after the check', async () => {
    const scratch = await trustedFixtureDirectory();
    cleanups.push(scratch.remove);
    const writable = path.join(scratch.directory, 'open');
    await fs.mkdir(writable);
    await fs.chmod(writable, 0o777);
    // Deleted before the session starts; the engine could write it again before the worker reads it.
    const script = path.join(writable, 'script.js');
    const { fixture, admin, connection, definition } = await setup();
    const changed = await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: connection.revision,
      definition: { ...definition, stdio: { ...definition.stdio, args: [script] } }, secrets: { token: SENTINEL },
    });
    expect(changed.type).toBe('applied');
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    expect((await initialize(session)).result.instructions).toContain('untrusted_argument');
    await session.close();
  });

  it('clears the worker state when the destination changes, and keeps it for a policy change', async () => {
    const { fixture, admin, connection, definition } = await setup();
    const marker = path.join(fixture.stateDir, 'connections', connection.id, 'token-cache.json');
    await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
    await fs.writeFile(marker, '{}', { mode: 0o600 });
    const policy = await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: connection.revision, definition: { ...definition, policy: { denyTools: [] } },
    });
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(true);
    await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: policy.connection.revision,
      definition: { ...definition, stdio: { ...definition.stdio, args: ['--elsewhere'] } }, secrets: { token: SENTINEL },
    });
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
  });

  it('runs the approved server with its credential, applies the policy and keeps the credential inside', async () => {
    const { fixture, connection } = await setup();
    const session = engineSession(fixture.engineSocketPath, connection.id);
    const received = [];
    expect(await session.next()).toEqual({ type: 'ready', connection: connection.id, name: 'fixture' });
    received.push(await initialize(session));
    expect(received[0].result.serverInfo.name).toBe('stdio-fixture');

    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await session.response(2)).message;
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(['whoami', 'slow', 'environment', 'echo_args']);

    session.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const whoami = (await session.response(3)).message;
    expect(whoami.result.content[0].text).toBe('credential matches');

    session.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
    const denied = (await session.response(4)).message;
    expect(denied.result.isError).toBe(true);

    session.send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'fixture://readme' } });
    expect((await session.response(5)).message.result.contents[0].text).toBe('fixture resource');
    session.send({ jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'greet' } });
    expect((await session.response(6)).message.result.messages[0].content.text).toBe('hello from the fixture');

    session.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: {} } });
    session.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'test' } });
    expect((await session.response(7)).message.error.code).toBe(-32800);

    session.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'environment', arguments: {} } });
    const names = (await session.response(8)).message.result.content[0].text.split(',');
    expect(names).toEqual(['EXPECTED_TOKEN_SHA256', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TOKEN']);

    received.push(tools, whoami, denied);
    expect(JSON.stringify(received)).not.toContain(SENTINEL);
    await session.close();
  });

  it('applies a policy change to a running session without ending it', async () => {
    const { fixture, admin, connection, definition } = await setup();
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    await initialize(session);
    const changed = await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: connection.revision,
      definition: { ...definition, policy: { allowTools: ['whoami'] } },
    });
    expect(changed.type).toBe('applied');
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await session.response(2)).message.result.tools.map((tool) => tool.name)).toEqual(['whoami']);
    expect(session.closed).toBe(false);
    await session.close();
  });

  it('accepts the editable definition Settings receives, unchanged or with a new policy', async () => {
    const { admin, connection } = await setup();
    const [view] = (await admin.list()).connections;
    // The page shows runtime readiness; it must never travel back in an update.
    expect(view.runtime).toBe('ready');
    expect(Object.keys(view.editable).sort()).toEqual(['enabled', 'name', 'policy', 'stdio', 'transport']);
    const unchanged = await admin.apply({ kind: 'update', id: connection.id, expectedRevision: view.revision, definition: view.editable });
    expect(unchanged.type).toBe('applied');
    expect(unchanged.connection.secrets).toEqual({ token: { set: true } });
    const policy = await admin.apply({
      kind: 'update', id: connection.id, expectedRevision: unchanged.connection.revision,
      definition: { ...unchanged.connection.editable, policy: { denyTools: ['slow'] } },
    });
    expect(policy.type).toBe('applied');
    expect(policy.connection.policy).toEqual({ denyTools: ['slow'] });
  });

  it('shuts down promptly with a session open and a client stuck in its first line', async () => {
    const { fixture, connection } = await setup();
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    await initialize(session);
    const stuck = net.createConnection(fixture.engineSocketPath);
    await new Promise((resolve) => stuck.once('connect', resolve));
    stuck.write('{"type":"hel');
    stuck.on('error', () => {});
    const started = Date.now();
    const outcome = await Promise.race([
      fixture.service.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 8000)),
    ]);
    expect(outcome).toBe('closed');
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(async () => { for (;;) await session.next({ timeoutMs: 3000 }); }).rejects.toThrow('session closed');
    expect(stuck.destroyed || stuck.readableEnded).toBe(true);
  });

  it('ends only the changed connection\'s sessions; other connections keep answering', async () => {
    const { fixture, admin, connection, definition } = await setup();
    const other = await admin.apply({ kind: 'create', definition: { ...definition, name: 'other' }, secrets: { token: SENTINEL } });
    const changed = engineSession(fixture.engineSocketPath, connection.id);
    const kept = engineSession(fixture.engineSocketPath, other.connection.id);
    await Promise.all([changed.next(), kept.next()]);
    await Promise.all([initialize(changed), initialize(kept)]);
    await admin.apply({ kind: 'revoke-credentials', id: connection.id, expectedRevision: connection.revision });
    await expect(async () => { for (;;) await changed.next({ timeoutMs: 5000 }); }).rejects.toThrow('session closed');
    kept.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    expect((await kept.response(2)).message.result.content[0].text).toBe('credential matches');
    expect(kept.closed).toBe(false);
    await kept.close();
  });

  it('ends the sessions of a revoked connection and then answers with the authorization tool', async () => {
    const { fixture, admin, connection } = await setup();
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    await initialize(session);
    const revoked = await admin.apply({ kind: 'revoke-credentials', id: connection.id, expectedRevision: connection.revision });
    expect(revoked.type).toBe('applied');
    await expect(async () => { for (;;) await session.next({ timeoutMs: 5000 }); }).rejects.toThrow('session closed');

    const next = engineSession(fixture.engineSocketPath, connection.id);
    await next.next();
    const init = await initialize(next);
    expect(init.result.instructions).toContain('has no stored credential');
    next.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await next.response(2)).message.result.tools.map((tool) => tool.name)).toEqual(['authorization_required']);
    next.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'authorization_required', arguments: {} } });
    const answer = (await next.response(3)).message;
    expect(answer.result.isError).toBe(true);
    await next.close();
  });

  it('refuses to run an executable the engine could change and says why', async () => {
    const { fixture, connection, scratch } = await setup();
    await fs.chmod(scratch.directory, 0o777);
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    const init = await initialize(session);
    expect(init.result.serverInfo.name).toBe('openchamber-protected-mcp');
    expect(init.result.instructions).toContain('untrusted_executable');
    await session.close();
    await fs.chmod(scratch.directory, 0o755);
  });

  it('refuses sessions for unknown and disabled connections before starting anything', async () => {
    const { fixture, admin, connection } = await setup();
    expect(await engineRequest(fixture.engineSocketPath, { type: 'hello', protocol: 1, connection: 'pmcp_ffffffffffffffff' }))
      .toEqual([{ type: 'error', code: 'unknown_connection' }]);
    await admin.apply({ kind: 'set-enabled', id: connection.id, expectedRevision: connection.revision, enabled: false });
    expect(await engineRequest(fixture.engineSocketPath, { type: 'hello', protocol: 1, connection: connection.id }))
      .toEqual([{ type: 'error', code: 'connection_disabled' }]);
    const workers = await fs.readdir(path.join(fixture.stateDir, 'connections')).catch(() => []);
    expect(workers).toEqual([]);
  });

  it('passes a secret file in the worker directory when the definition asks for one, and removes it afterwards', async () => {
    const { fixture, connection } = await setup({ env: { TOKEN: 'not the credential', TOKEN_FILE: { secretFile: 'token' } } });
    const session = engineSession(fixture.engineSocketPath, connection.id);
    await session.next();
    await initialize(session);
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    expect((await session.response(2)).message.result.content[0].text).toBe('credential matches');
    const secrets = path.join(fixture.stateDir, 'connections', connection.id, 'secrets');
    const [sessionDirectory] = await fs.readdir(secrets);
    expect((await fs.stat(path.join(secrets, sessionDirectory))).mode & 0o077).toBe(0);
    expect((await fs.stat(path.join(secrets, sessionDirectory, 'token'))).mode & 0o077).toBe(0);
    await session.close();
    await expect.poll(() => fs.readdir(secrets), { timeout: 10_000 }).toEqual([]);
  });

  it('gives every session its own secret files, so one ending leaves the other\'s in place', async () => {
    const { fixture, connection } = await setup({ env: { TOKEN: 'not the credential', TOKEN_FILE: { secretFile: 'token' } } });
    const whoami = async (session, id) => {
      session.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
      return (await session.response(id)).message.result.content[0].text;
    };
    const first = engineSession(fixture.engineSocketPath, connection.id);
    await first.next();
    await initialize(first);
    const second = engineSession(fixture.engineSocketPath, connection.id);
    await second.next();
    await initialize(second);
    expect(await whoami(first, 2)).toBe('credential matches');
    expect(await whoami(second, 2)).toBe('credential matches');
    const secrets = path.join(fixture.stateDir, 'connections', connection.id, 'secrets');
    expect(await fs.readdir(secrets)).toHaveLength(2);
    await second.close();
    await expect.poll(() => fs.readdir(secrets).then((names) => names.length, () => -1), { timeout: 10_000 }).toBe(1);
    // The first worker reads its file again after the second one is gone.
    expect(await whoami(first, 3)).toBe('credential matches');
    await first.close();
    await expect.poll(() => fs.readdir(secrets).then((names) => names.length, () => -1), { timeout: 10_000 }).toBe(0);
  });

  it('deletes secret files a crashed run left behind when the service starts', async () => {
    const { fixture, connection } = await setup();
    const leftover = path.join(fixture.stateDir, 'connections', connection.id, 'secrets', 'session-crashed');
    await fs.mkdir(leftover, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(leftover, 'token'), SENTINEL, { mode: 0o600 });
    await fixture.service.close();
    await fixture.service.start();
    await expect(fs.stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
