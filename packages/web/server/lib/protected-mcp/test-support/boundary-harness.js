// The multi-identity boundary proof. Everything here runs inside a disposable
// container, where root creates real Linux accounts and the kernel enforces
// file and process permissions between them. The host only reads the results.

/** Pinned like the spaces base image: Debian with Node.js 24. */
export const BOUNDARY_IMAGE = 'node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0';

/**
 * Root's part, as the administrator would do it: install with the real
 * installer, start the service as its own account, create one connection with
 * a credential only root ever sees, then let the engine account probe.
 * `MUTATION` names a protection to remove, to show the probes can fail.
 */
export const INSIDE_SCRIPT = String.raw`#!/bin/bash
set -euo pipefail
export LANG=C.UTF-8
exec > >(tee /out/inside.log) 2>&1
MUTATION="${'$'}{MUTATION:-none}"
NODE=/usr/local/bin/node
SERVICE_DIR=/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service

useradd --create-home --shell /bin/bash engine
# The credential exists only in root's memory and root-only files.
SENTINEL="boundary-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
umask 077
printf '%s' "${'$'}SENTINEL" > /root/sentinel

mkdir -p /usr/local/lib/pmcp-fixture
cp /harness/stdio-fixture-server.js /usr/local/lib/pmcp-fixture/server.mjs
chmod 755 /usr/local/lib/pmcp-fixture
chmod 644 /usr/local/lib/pmcp-fixture/server.mjs

"${'$'}NODE" /src/server/lib/protected-mcp/service/install.js install \
  --source /src/server --version boundary --engine-user engine --node "${'$'}NODE" --no-start
useradd --create-home outsider
useradd --create-home --groups openchamber-mcp-clients clientonly
useradd --create-home --groups openchamber-mcp-admins adminonly
# Emulate SupplementaryGroups and RuntimeDirectory as User:Group with RuntimeDirectoryMode.
# The service itself assigns the configured groups to the directories and sockets.
usermod --append --groups openchamber-mcp-clients,openchamber-mcp-admins openchamber-mcp
install -d -o openchamber-mcp -g openchamber-mcp -m 0750 /run/openchamber-protected-mcp /run/openchamber-protected-mcp-admin

# Code is opened before the service starts, so its own check sees it.
if [ "${'$'}MUTATION" = code-writable ]; then chmod 777 "${'$'}SERVICE_DIR"; fi

env -u OPENCHAMBER_ALLOW_NETWORK_ACCESS OPENCHAMBER_ENTERPRISE_MODE=1 \
  setpriv --reuid=openchamber-mcp --regid=openchamber-mcp --init-groups --no-new-privs -- \
  "${'$'}NODE" "${'$'}SERVICE_DIR/main.js" --config /etc/openchamber/protected-mcp/service.json > /out/service.log 2>&1 &
SERVICE_PID=$!
trap 'kill "${'$'}SERVICE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q 'service_started' /out/service.log && break; sleep 0.2; done
grep -q 'service_started' /out/service.log || { echo "service did not start"; cat /out/service.log; exit 1; }

# Root creates the connection through the administration socket.
# The credential goes by a root-only file, never by argument: /proc/<pid>/cmdline is world-readable.
SENTINEL_FILE=/root/sentinel "${'$'}NODE" /harness/admin.mjs > /out/admin.json
SERVICE_PID="${'$'}SERVICE_PID" "${'$'}NODE" /harness/matrix.mjs > /out/matrix.json
if [ "${'$'}MUTATION" = admin-socket-open ]; then
  chmod 0755 /run/openchamber-protected-mcp-admin
  chmod 0666 /run/openchamber-protected-mcp-admin/admin.sock
fi
SERVICE_PID="${'$'}SERVICE_PID" "${'$'}NODE" /harness/matrix.mjs > /out/matrix-after.json

# State is opened after the service started: at start it resets its own directory to 0700.
if [ "${'$'}MUTATION" = state-readable ]; then chmod -R go+rX /var/lib/openchamber-protected-mcp; fi

# The engine's turn. It never learns the credential, so it cannot search for it:
# it collects what it can reach, and root searches that afterwards.
chown -R engine:engine /out/engine 2>/dev/null || install -d -o engine -g engine /out/engine
su engine --shell /bin/bash --command "${'$'}NODE /harness/probes.mjs /out/engine" > /out/probes.log 2>&1 || true
"${'$'}NODE" /harness/search.mjs /out/engine /root/sentinel > /out/search.json
# Search while the original credential is still stored, then exercise rebinding.
su engine --shell /bin/bash --command "${'$'}NODE /harness/redirect.mjs /out/engine" > /out/redirect.json
"${'$'}NODE" /harness/search.mjs /out/engine /root/sentinel > /out/search-after.json

# Service loss: the relay must fail closed and fast.
kill "${'$'}SERVICE_PID"
wait "${'$'}SERVICE_PID"
trap - EXIT
su engine --shell /bin/bash --command "${'$'}NODE /harness/after-loss.mjs" > /out/after-loss.json 2>&1 || true

# Root here is the host user outside: give everything back so the host can clean up.
chown -R root:root /out
chmod -R u+rwX /out
echo done
`;

/** Root creates the protected fixture with a synthetic credential. */
export const ADMIN_SCRIPT = String.raw`
import fs from 'node:fs';
import { adminRequest } from '/harness/admin-socket-client.mjs';
const sentinel = (await import('node:fs')).readFileSync(process.env.SENTINEL_FILE, 'utf8');
// This root-owned fixture reveals TOKEN only after the destination is changed.
// Reusing the old credential would therefore leak it into the collected output.
const fixture = '/usr/local/lib/pmcp-fixture/server.mjs';
const original = fs.readFileSync(fixture, 'utf8');
const redirected = original.replace("Object.keys(process.env).sort().join(',')", "process.env.BOUNDARY_REDIRECT === '1' ? currentToken() : Object.keys(process.env).sort().join(',')");
if (redirected === original) throw new Error('fixture environment tool was not adapted');
fs.writeFileSync(fixture, redirected);
const hash = (await import('node:crypto')).createHash('sha256').update(sentinel).digest('hex');
const created = await adminRequest('/run/openchamber-protected-mcp-admin/admin.sock', {
  type: 'apply',
  operation: {
    kind: 'create',
    definition: {
      name: 'boundary',
      transport: 'stdio',
      stdio: { command: '/usr/local/bin/node', args: ['/usr/local/lib/pmcp-fixture/server.mjs'], env: { TOKEN: { secret: 'token' }, EXPECTED_TOKEN_SHA256: hash } },
      policy: { denyTools: ['delete_everything'] },
    },
    secrets: { token: sentinel },
  },
});
process.stdout.write(JSON.stringify({ id: created.connection?.id ?? null, error: created.code ?? null }));
`;

/** The same bounded JSON request is used by each real Linux identity. */
export const SOCKET_SCRIPT = String.raw`
import { adminRequest } from '/harness/admin-socket-client.mjs';
try {
  const answer = await adminRequest(process.argv[2], { type: process.argv[3] });
  process.stdout.write(JSON.stringify({ allowed: true, answer }));
} catch (error) {
  process.stdout.write(JSON.stringify({ allowed: false, code: error.code ?? error.message }));
}
`;

/** Root records kernel permissions, actual process environment and TCP ownership. */
export const MATRIX_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
const matrix = {};
for (const user of ['outsider', 'clientonly', 'adminonly', 'engine']) {
  matrix[user] = { groups: execFileSync('id', ['-Gn', user]).toString().trim().split(/\s+/) };
  for (const [kind, socket, type] of [
    ['engine', '/run/openchamber-protected-mcp/engine.sock', 'status'],
    ['admin', '/run/openchamber-protected-mcp-admin/admin.sock', 'list'],
  ]) {
    matrix[user][kind] = JSON.parse(execFileSync('su', [user, '--shell', '/bin/bash', '--command', '/usr/local/bin/node /harness/socket.mjs ' + socket + ' ' + type]).toString());
  }
}
const permissions = {};
for (const target of ['/run/openchamber-protected-mcp', '/run/openchamber-protected-mcp/engine.sock', '/run/openchamber-protected-mcp-admin', '/run/openchamber-protected-mcp-admin/admin.sock']) {
  permissions[target] = execFileSync('stat', ['-c', '%U:%G %a', target]).toString().trim();
}
// Docker root lacks CAP_SYS_PTRACE; inspect the broker as its own UID.
const service = JSON.parse(execFileSync('su', ['openchamber-mcp', '--shell', '/bin/bash', '--command', '/usr/local/bin/node /harness/process.mjs ' + process.env.SERVICE_PID]).toString());
process.stdout.write(JSON.stringify({ matrix, permissions, service }));
`;

export const PROCESS_SCRIPT = String.raw`
import fs from 'node:fs';
import net from 'node:net';
const pid = process.argv[2];
const environment = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
// A local control proves the inode comparison detects a real listening process.
const control = net.createServer();
await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
const listenInodes = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((file) => fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((fields) => fields[3] === '0A').map((fields) => fields[9]));
const socketsOf = (processId) => fs.readdirSync('/proc/' + processId + '/fd').flatMap((fd) => {
  try { return [fs.readlinkSync('/proc/' + processId + '/fd/' + fd)]; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}).flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.slice(1) ?? []);
const serviceSockets = socketsOf(pid);
const controlListening = socketsOf(process.pid).filter((inode) => listenInodes.includes(inode));
await new Promise((resolve) => control.close(resolve));
process.stdout.write(JSON.stringify({
  running: fs.existsSync('/proc/' + pid),
  enterpriseMode: environment.includes('OPENCHAMBER_ENTERPRISE_MODE=1'),
  networkAccessUnset: !environment.some((entry) => entry.startsWith('OPENCHAMBER_ALLOW_NETWORK_ACCESS=')),
  tcp: { listenInodes, serviceSockets, serviceListening: serviceSockets.filter((inode) => listenInodes.includes(inode)), controlListening },
}));
`;

/**
 * The engine account's probes: a positive call through the relay, then every
 * read, write and request the engine could try. It records outcomes and copies
 * whatever it could read into its own directory for root to search.
 */
export const PROBES_SCRIPT = String.raw`
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { adminRequest } from '/harness/admin-socket-client.mjs';
import path from 'node:path';

const out = process.argv[2];
const results = {};
const collected = path.join(out, 'collected');
fs.mkdirSync(collected, { recursive: true });
const keep = (name, data) => fs.writeFileSync(path.join(collected, name.replace(/[^A-Za-z0-9._-]/g, '_')), data);
const attempt = (name, run) => {
  try {
    const value = run();
    results[name] = { allowed: true };
    if (value !== undefined) keep(name, value);
  } catch (error) {
    results[name] = { allowed: false, code: error.code ?? error.message };
  }
};

const state = '/var/lib/openchamber-protected-mcp';
const servicePids = execFileSync('pgrep', ['-u', 'openchamber-mcp']).toString().trim().split(/\s+/);
results.servicePids = servicePids.length;

// Reads the engine must not manage.
attempt('read_state_dir', () => fs.readdirSync(state).join('\n'));
attempt('read_state.json', () => fs.readFileSync(path.join(state, 'state.json')));
attempt('read_credentials_dir', () => fs.readdirSync(path.join(state, 'credentials')).join('\n'));
for (const pid of servicePids) {
  attempt('environ_' + pid, () => fs.readFileSync('/proc/' + pid + '/environ'));
  attempt('mem_' + pid, () => { const fd = fs.openSync('/proc/' + pid + '/mem', 'r'); fs.closeSync(fd); return 'opened'; });
  // cmdline is world-readable on Linux; it is collected so root can confirm no credential is in it.
  try { keep('cmdline_' + pid, fs.readFileSync('/proc/' + pid + '/cmdline')); } catch {}
}

// Writes to what the service runs or trusts: changing a file, or adding one beside it.
const writes = {
  write_service_code: '/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js',
  write_service_config: '/etc/openchamber/protected-mcp/service.json',
  write_fixture_runtime: '/usr/local/lib/pmcp-fixture/server.mjs',
  write_worker_path_binary: '/usr/local/bin/node',
};
for (const [name, file] of Object.entries(writes)) {
  attempt(name, () => {
    try {
      fs.appendFileSync(file, '');
    } catch {
      fs.writeFileSync(path.join(path.dirname(file), 'engine-probe'), 'x');
    }
    return undefined;
  });
}
attempt('replace_current_symlink', () => { fs.symlinkSync('/tmp', '/usr/lib/openchamber-protected-mcp/current.engine'); return undefined; });
attempt('write_state_dir', () => { fs.writeFileSync(path.join(state, 'engine.txt'), 'x'); return undefined; });

// The engine socket: status is public, administration does not exist there.
const frame = async (value) => JSON.stringify(await adminRequest('/run/openchamber-protected-mcp/engine.sock', value));
const statusText = await frame({ type: 'status' });
keep('status.json', statusText);
const status = JSON.parse(statusText);
results.status_enforcement = status.enforcement.status;
results.administration = status.administration;
const id = status.connections[0]?.id;
for (const type of ['create', 'update', 'export', 'getCredential', 'approve']) {
  const answer = await frame({ type, connection: id });
  keep('socket_' + type, answer);
  results['socket_' + type] = answer.trim();
}

// Stage 1 deliberately gives the engine admin authority; reads remain redacted.
for (const request of [{ type: 'list' }, { type: 'get', id }]) {
  const answer = await adminRequest('/run/openchamber-protected-mcp-admin/admin.sock', request);
  keep('admin_' + request.type + '.json', JSON.stringify(answer));
  results['admin_' + request.type] = answer.type;
}

// The positive control: an authorized call through the relay works.
const relay = spawn('/usr/local/bin/node', ['/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js', '--socket', '/run/openchamber-protected-mcp/engine.sock', id], { stdio: ['pipe', 'pipe', 'pipe'] });
let relayOut = '';
relay.stdout.on('data', (chunk) => { relayOut += chunk; });
const send = (message) => relay.stdin.write(JSON.stringify(message) + '\n');
const until = (predicate) => new Promise((resolve) => {
  const timer = setInterval(() => { if (predicate()) { clearInterval(timer); resolve(); } }, 50);
  setTimeout(() => { clearInterval(timer); resolve(); }, 15000);
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
await until(() => relayOut.includes('"id":1'));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
await until(() => relayOut.includes('"id":2'));
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'environment', arguments: {} } });
await until(() => relayOut.includes('"id":3'));
results.relay_whoami = relayOut.includes('credential matches') ? 'credential matches' : 'no match';
keep('relay_output.txt', relayOut);

// While the worker runs: it belongs to the service account, so its environment is closed too.
const workers = execFileSync('pgrep', ['-u', 'openchamber-mcp']).toString().trim().split(/\s+/).filter((pid) => !servicePids.includes(pid));
results.worker_pids = workers.length;
for (const pid of workers) {
  attempt('worker_environ_' + pid, () => fs.readFileSync('/proc/' + pid + '/environ'));
  try { keep('worker_cmdline_' + pid, fs.readFileSync('/proc/' + pid + '/cmdline')); } catch {}
}
relay.stdin.end();
await new Promise((resolve) => relay.on('exit', resolve));

// Everything else the engine can read on the paths that matter. find exits 1
// as soon as it meets a directory it may not open, so its output counts either
// way; the per-root counts show the collection really covered each root.
results.collected = {};
let copies = 0;
for (const root of ['/run', '/tmp', '/var/tmp', '/dev/shm', '/etc/openchamber', '/usr/lib/openchamber-protected-mcp', '/var/lib', '/home']) {
  const found = spawnSync('find', [root, '-type', 'f', '-readable', '-size', '-2M'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const listing = (found.stdout ?? Buffer.alloc(0)).toString().split('\n').filter((file) => file && !file.startsWith(out));
  let kept = 0;
  for (const file of listing) {
    try {
      copies += 1;
      keep('fs-' + copies + file, fs.readFileSync(file));
      kept += 1;
    } catch {}
  }
  results.collected[root] = kept;
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.stdout.write(JSON.stringify(results, null, 2));
`;

/** Rebinding is attempted only after the original credential's search and control. */
export const REDIRECT_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { adminRequest } from '/harness/admin-socket-client.mjs';
const request = (frame) => adminRequest('/run/openchamber-protected-mcp-admin/admin.sock', frame);
const { connections: [connection] } = await request({ type: 'list' });
const definition = { ...connection.editable, stdio: { ...connection.editable.stdio, env: { ...connection.editable.stdio.env, BOUNDARY_REDIRECT: '1' } } };
const operation = { kind: 'update', id: connection.id, expectedRevision: connection.revision, definition };
const refused = await request({ type: 'apply', operation });
const unchanged = await request({ type: 'get', id: connection.id });
const accepted = await request({ type: 'apply', operation: { ...operation, secrets: { token: 'engine-typed-value' } } });
const relay = spawn('/usr/local/bin/node', ['/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js', '--socket', '/run/openchamber-protected-mcp/engine.sock', connection.id], { stdio: ['pipe', 'pipe', 'pipe'] });
const exited = new Promise((resolve) => relay.once('exit', resolve));
const lines = readline.createInterface({ input: relay.stdout });
const answers = new Map();
let output = '';
relay.stdout.on('data', (chunk) => { output += chunk; });
lines.on('line', (line) => { const answer = JSON.parse(line); answers.get(answer.id)?.(answer); });
const call = (message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { relay.kill(); reject(new Error('redirect relay did not answer')); }, 15000);
  answers.set(message.id, (answer) => { clearTimeout(timer); answers.delete(message.id); resolve(answer); });
  relay.stdin.write(JSON.stringify(message) + '\n');
});
try {
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'redirect-probe', version: '1' } } });
  relay.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const environment = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'environment', arguments: {} } });
  fs.writeFileSync(path.join(process.argv[2], 'collected', 'redirect.txt'), JSON.stringify({ refused, unchanged, accepted, output }));
  process.stdout.write(JSON.stringify({ refused: refused.code, unchanged: unchanged.connection.revision === connection.revision && unchanged.connection.credential === 'stored' && unchanged.connection.editable.stdio.env.BOUNDARY_REDIRECT === undefined, accepted: accepted.type, environment: environment.result?.content }));
} finally {
  relay.stdin.end();
  await exited;
  lines.close();
}
`;

/** After the service is gone, a relay must exit with an error, quickly. */
export const AFTER_LOSS_SCRIPT = String.raw`
import { spawnSync } from 'node:child_process';
const started = Date.now();
const run = spawnSync('/usr/local/bin/node', ['/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js', '--socket', '/run/openchamber-protected-mcp/engine.sock', 'pmcp_0123456789abcdef'], { input: '', timeout: 15000 });
process.stdout.write(JSON.stringify({ exit: run.status, ms: Date.now() - started, stderr: run.stderr.toString().trim() }));
`;

/** Root searches what the engine collected for the credential it never knew. */
export const SEARCH_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const [, , directory, sentinelFile] = process.argv;
const sentinel = fs.readFileSync(sentinelFile, 'utf8');
const hits = [];
let files = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else { files += 1; if (fs.readFileSync(full).includes(sentinel)) hits.push(path.relative(directory, full)); }
  }
};
walk(directory);
// Positive control: the protected state does hold it, so a miss above is meaningful.
const control = fs.readdirSync('/var/lib/openchamber-protected-mcp/credentials').some((name) => fs.readFileSync(path.join('/var/lib/openchamber-protected-mcp/credentials', name)).includes(sentinel));
process.stdout.write(JSON.stringify({ filesSearched: files, hits, controlFoundInProtectedState: control }));
`;
