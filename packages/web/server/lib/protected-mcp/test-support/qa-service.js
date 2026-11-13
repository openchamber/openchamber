#!/usr/bin/env node
// Runs a protected MCP service over a temporary state directory for manual QA,
// with synthetic stdio, HTTP, migrated and OAuth connections. It writes
// the client configuration OpenChamber reads and prints only non-secret facts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProtectedMcpService } from '../service/service.js';
import { createIntegrity } from '../service/integrity.js';
import { runPreflight } from '../service/preflight.js';
import { createAdminSocketClient } from './admin-socket-client.js';
import { startHttpFixture } from './http-fixture.js';
import { installStdioFixture, sha256, trustedFixtureDirectory } from './fixtures.js';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const root = path.resolve(option('--root', '/tmp/opencode/pmcp-qa'));
const sentinel = option('--sentinel', 'qa-sentinel-9b2f-never-in-engine');

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const stateDir = path.join(root, 'state');
const scratch = await trustedFixtureDirectory();
const command = await installStdioFixture(scratch.directory);
const upstream = await startHttpFixture({ bearer: sentinel });
const oauthUpstream = await startHttpFixture({ oauth: true });
const adminSocket = path.join(root, 'admin.sock');

const engine = { uid: 2_000_000_000, gids: [2_000_000_000] };
const integrityOptions = { owners: [0, process.getuid()], engine };
const service = await createProtectedMcpService({
  version: 'qa',
  stateDir,
  engineSocketPath: path.join(root, 'engine.sock'),
  adminSocketPath: adminSocket,
  integrity: integrityOptions,
  enforcement: () => runPreflight({
    integrity: createIntegrity(integrityOptions),
    engine,
    engineUser: 'qa-engine',
    adminSocket,
    trustedPaths: [scratch.directory],
    privateDirectories: [stateDir],
  }),
});
await service.start();

const admin = createAdminSocketClient(adminSocket);
for (const [definition, secrets] of [
  [{ name: 'qa-stdio', transport: 'stdio', stdio: { command, env: { TOKEN: { secret: 'token' }, EXPECTED_TOKEN_SHA256: sha256(sentinel) } }, policy: { denyTools: ['delete_everything'] } }, { token: sentinel }],
  [{ name: 'qa-http', transport: 'http', http: { url: upstream.url, headers: { Authorization: { secret: 'token', prefix: 'Bearer ' } } } }, { token: sentinel }],
  [{ name: 'qa-migrated', transport: 'stdio', stdio: { command, env: { TOKEN_FILE: { secretFile: 'token' }, EXPECTED_TOKEN_SHA256: sha256(sentinel), CACHE_DIR: { state: 'cache' } } }, policy: { denyTools: ['delete_everything'], defaultArguments: { greeting: 'qa' } } }, { token: sentinel }],
  [{ name: 'qa-oauth', transport: 'http', http: { url: oauthUpstream.url, oauth: { scopes: ['read'] } } }, {}],
]) {
  const answer = await admin.create(definition, secrets);
  if (answer.type !== 'applied') throw new Error(answer.code);
}

const relay = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../service/relay.js');
const clientConfig = path.join(root, 'client.json');
await fs.writeFile(clientConfig, `${JSON.stringify({ version: 1, socket: path.join(root, 'engine.sock'), adminSocket, relay: [process.execPath, relay] }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pid: process.pid, adminSocket, clientConfig, connections: service.status().connections.map((connection) => connection.id) })}\n`);

const stop = async () => {
  await service.close();
  await upstream.close();
  await oauthUpstream.close();
  await scratch.remove();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
