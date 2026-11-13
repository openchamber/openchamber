#!/usr/bin/env node
// The stdio MCP server OpenCode starts for a protected connection. It carries
// MCP messages between OpenCode and the protected service's engine socket and
// holds no credential: the engine could open that socket itself.
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, isConnectionId } from './contract.js';

const USAGE = `Usage: relay.js --socket <path> <connection-id>

Connects an MCP client on stdin and stdout to a connection of the
OpenChamber protected MCP service. The service holds the credentials;
this process never sees them.

Exit codes: 0 after a normal end, 64 for wrong arguments, 69 when the
service is unreachable or refuses the connection, 75 when the service
ended the session.
`;

const EXIT = { ok: 0, usage: 64, unavailable: 69, ended: 75 };
const CONNECT_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 10_000;

const REFUSALS = {
  unknown_connection: 'the service has no such connection',
  connection_disabled: 'the administrator disabled this connection',
  protocol_mismatch: 'the service speaks another protocol version; update OpenChamber or the service',
  too_many_sessions: 'the service has too many open sessions',
};

function parseArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let socket = null;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--socket') {
      socket = argv[index + 1] ?? null;
      index += 1;
    } else positional.push(argv[index]);
  }
  if (!socket || positional.length !== 1 || !isConnectionId(positional[0])) return { error: true };
  return { socket, connection: positional[0] };
}

function runRelay({ argv, stdin, stdout, stderr, exit }) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return exit(EXIT.ok);
  }
  if (parsed.error) {
    stderr.write(USAGE);
    return exit(EXIT.usage);
  }
  const say = (text) => stderr.write(`openchamber-protected-mcp: ${text}\n`);
  let ready = false;
  let stdinEnded = false;
  let finished = false;
  let buffer = Buffer.alloc(0);
  const finish = (code, text) => {
    if (finished) return;
    finished = true;
    if (text) say(text);
    exit(code);
  };

  const socket = net.createConnection({ path: parsed.socket, allowHalfOpen: true });
  const connectTimer = setTimeout(() => {
    socket.destroy();
    finish(EXIT.unavailable, `the protected MCP service did not answer at ${parsed.socket}`);
  }, CONNECT_TIMEOUT_MS);
  let readyTimer = null;

  socket.once('connect', () => {
    clearTimeout(connectTimer);
    readyTimer = setTimeout(() => {
      socket.destroy();
      finish(EXIT.unavailable, 'the protected MCP service did not accept the session in time');
    }, READY_TIMEOUT_MS);
    socket.write(`${JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, connection: parsed.connection })}\n`);
  });
  socket.on('error', (error) => {
    clearTimeout(connectTimer);
    clearTimeout(readyTimer);
    finish(EXIT.unavailable, ready
      ? 'the connection to the protected MCP service failed'
      : `the protected MCP service is not reachable at ${parsed.socket} (${error.code ?? 'error'})`);
  });
  socket.on('data', (chunk) => {
    if (ready) {
      stdout.write(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(0x0a);
    if (end === -1) return;
    clearTimeout(readyTimer);
    let answer = null;
    try {
      answer = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    } catch {
      answer = null;
    }
    if (answer?.type !== 'ready') {
      socket.destroy();
      const reason = REFUSALS[answer?.code] ?? `refused (${answer?.code ?? 'unreadable answer'})`;
      finish(EXIT.unavailable, `protected connection ${parsed.connection}: ${reason}`);
      return;
    }
    ready = true;
    const rest = buffer.subarray(end + 1);
    buffer = Buffer.alloc(0);
    if (rest.length > 0) stdout.write(rest);
    stdin.on('data', (data) => socket.write(data));
    stdin.on('end', () => {
      stdinEnded = true;
      socket.end();
    });
    stdin.resume();
  });
  // The service ending its side ends the session; close ours so `close` follows.
  socket.on('end', () => socket.end());
  socket.on('close', () => {
    clearTimeout(connectTimer);
    clearTimeout(readyTimer);
    if (!ready) return finish(EXIT.unavailable, 'the protected MCP service closed the connection before the session started');
    return stdinEnded ? finish(EXIT.ok) : finish(EXIT.ended, 'the protected MCP service ended the session');
  });
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.stdin.pause();
  runRelay({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => {
      process.exitCode = code;
      if (process.stdout.writableLength === 0) process.exit(code);
      else process.stdout.once('drain', () => process.exit(code));
    },
  });
}
