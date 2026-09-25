// `openCommandStream` of run-command.js, and the bridge of `connect` from layout.js, run on the
// host with this Node: the stream that the dispatcher's agent uses as a socket.

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { CONNECT_BRIDGE_PROGRAM } from './layout.js';
import { openCommandStream } from './run-command.js';

const node = process.execPath;
const ECHO = 'process.stdin.pipe(process.stdout)';
const servers = [];
const streams = [];

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); });
});
const open = (file, args) => {
  const stream = openCommandStream(file, args);
  streams.push(stream);
  return stream;
};
const bridgeTo = (port) => open(node, ['-e', CONNECT_BRIDGE_PROGRAM, '127.0.0.1', String(port)]);
const closed = (stream) => new Promise((resolve) => { if (stream.closed) resolve(); else stream.once('close', resolve); });
const failure = (stream) => new Promise((resolve) => stream.once('error', resolve));
const collect = (stream) => new Promise((resolve) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.destroy();
    await closed(stream);
  }
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(() => resolve()));
});

describe('openCommandStream', () => {
  it('carries bytes both ways and ends when the command ends', async () => {
    const stream = open(node, ['-e', ECHO]);
    const sent = crypto.randomBytes(1024 * 1024);
    const received = collect(stream);
    stream.end(sent);
    expect((await received).equals(sent)).toBe(true);
    await closed(stream);
    expect(stream.errored).toBeNull();
  });

  it('ends with an error that carries the command\'s stderr when it fails before it answers', async () => {
    const stream = open(node, ['-e', 'process.stderr.write("no route to the server"); process.exit(3)']);
    stream.resume();
    const error = await failure(stream);
    expect(error).toMatchObject({ code: 'command_stream_failed', message: expect.stringMatching(/exited with code 3: no route to the server/) });
  });

  it('ends with an error when the command answers nothing and leaves quietly', async () => {
    const stream = open(node, ['-e', 'process.exit(0)']);
    stream.resume();
    expect(await failure(stream)).toMatchObject({ code: 'command_stream_failed' });
  });

  it('kills the command when it is destroyed', async () => {
    const stream = open(node, ['-e', 'setInterval(() => {}, 1000)']);
    const { pid } = stream;
    stream.destroy();
    await closed(stream);
    for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(alive(pid)).toBe(false);
  });

  it('emits timeout after the given silence, and not while bytes flow', async () => {
    const stream = open(node, ['-e', ECHO]);
    stream.resume();
    let timeouts = 0;
    stream.setTimeout(150, () => { timeouts += 1; });
    for (let round = 0; round < 4; round += 1) {
      stream.write('tick');
      await new Promise((resolve) => { setTimeout(resolve, 60); });
    }
    expect(timeouts).toBe(0);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(timeouts).toBe(1);
    expect(stream.timeout).toBe(150);
  });

  it('answers a command that cannot start with an error, not an exception', async () => {
    const stream = open('/nonexistent/program/of-ours', []);
    stream.resume();
    expect(await failure(stream)).toMatchObject({ code: 'command_spawn_failed' });
  });
});

describe('the connect bridge', () => {
  it('carries HTTP requests over a keep-alive agent, many on one command', async () => {
    let requests = 0;
    const port = await listen(http.createServer((request, response) => {
      requests += 1;
      let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; });
      request.on('end', () => response.end(JSON.stringify({ url: request.url, bytes, big: 'y'.repeat(300_000) })));
    }));
    let opened = 0;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = (_options, callback) => { opened += 1; callback(null, bridgeTo(port)); };
    const call = (path, body = null) => new Promise((resolve, reject) => {
      const request = http.request({ agent, host: '127.0.0.1', port: 9, path, method: body ? 'POST' : 'GET' }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      request.on('error', reject);
      request.end(body);
    });

    expect(await call('/one')).toMatchObject({ url: '/one', bytes: 0 });
    expect(await call('/two', Buffer.alloc(2 * 1024 * 1024, 1))).toMatchObject({ url: '/two', bytes: 2 * 1024 * 1024 });
    const parallel = await Promise.all(['/a', '/b', '/c'].map((path) => call(path)));
    expect(parallel.map((answer) => answer.url)).toEqual(['/a', '/b', '/c']);
    expect(requests).toBe(5);
    expect(opened).toBe(1);
    agent.destroy();
  });

  it('carries a large answer whole while the other side is still sending', async () => {
    const outgoing = crypto.randomBytes(4 * 1024 * 1024);
    const incoming = crypto.randomBytes(4 * 1024 * 1024);
    let seenAtServer = null;
    const port = await listen(net.createServer((socket) => {
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => { seenAtServer = Buffer.concat(chunks); socket.end(); });
      socket.write(incoming);
    }));
    const stream = bridgeTo(port);
    const received = collect(stream);
    stream.end(outgoing);
    const answer = await received;
    expect(crypto.createHash('sha256').update(answer).digest('hex')).toBe(crypto.createHash('sha256').update(incoming).digest('hex'));
    await closed(stream);
    expect(crypto.createHash('sha256').update(seenAtServer).digest('hex')).toBe(crypto.createHash('sha256').update(outgoing).digest('hex'));
  });

  it('fails with the connection error when nothing listens on the port', async () => {
    const stream = bridgeTo(1);
    stream.resume();
    stream.write('GET / HTTP/1.1\r\n\r\n');
    const error = await failure(stream);
    expect(error).toMatchObject({ code: 'command_stream_failed', message: expect.stringMatching(/exited with code 1: ECONNREFUSED/) });
  });

  it('ends its command when the host lets go, and when the server closes', async () => {
    const sockets = [];
    const port = await listen(net.createServer((socket) => { sockets.push(socket); socket.write('hello'); }));
    const first = bridgeTo(port);
    await new Promise((resolve) => first.once('data', resolve));
    const firstPid = first.pid;
    first.destroy();
    await closed(first);
    for (let attempt = 0; attempt < 50 && alive(firstPid); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(alive(firstPid)).toBe(false);

    const second = bridgeTo(port);
    await new Promise((resolve) => second.once('data', resolve));
    sockets[1].end();
    await closed(second);
    expect(second.errored).toBeNull();
  });
});
