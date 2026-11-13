import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostdServer } from './server.js';
import { createHostdClient } from './client.js';

const dispose = [];
afterEach(async () => { for (const cleanup of dispose.splice(0).reverse()) await cleanup(); });
const fixture = async (daemon) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-client-'));
  dispose.push(() => fs.rm(root, { recursive: true, force: true }));
  const host = createHostdServer(daemon);
  dispose.push(host.close);
  const socketPath = path.join(root, 'hostd.sock');
  host.server.listen(socketPath);
  await once(host.server, 'listening');
  return createHostdClient({ socketPath });
};

describe('hostd client over a real socket', () => {
  it('refuses unknown fields before the privileged handler is called', async () => {
    let calls = 0;
    const client = await fixture({ request: async () => { calls += 1; return { available: true }; } });
    await expect(client.request({ op: 'check', uid: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toBe(0);
    expect(await client.request({ op: 'check' })).toEqual({ available: true });
  });
  it('carries a packed-size tools payload in individually bounded frames', async () => {
    const input = Buffer.alloc(5 * 1024 * 1024 + 9, 37);
    const client = await fixture({ request: async (_request, io) => ({ equal: io.input.equals(input), bytes: io.input.length }) });
    const result = await client.request({ op: 'tools-ensure', key: '1234567890abcdef', input: null }, { input });
    expect(result).toEqual({ equal: true, bytes: input.length });
  });
  it('carries binary streams and preserves a nonzero command exit', async () => {
    const input = Buffer.alloc(2 * 1024 * 1024 + 13, 255);
    const client = await fixture({ request: async (_request, io) => {
      for await (const bytes of io.stdin) await io.stdout(bytes);
      await io.stderr(Buffer.from('command diagnostic'));
      return 17;
    } });
    const result = await client.exec({ op: 'exec', place: 'host', id: '123456abcdef', target: 'space', argv: ['cat'] }, { stdin: input });
    expect(result.code).toBe(17);
    expect(result.stderr).toBe('command diagnostic');
    expect(result.stdout).toBe(input.toString('utf8'));
  });
  it('keeps the exact tail across chunk boundaries', async () => {
    const bytes = Buffer.concat([Buffer.alloc(65536, 97), Buffer.alloc(65536, 98), Buffer.alloc(65536, 99)]);
    const client = await fixture({ request: async (_request, io) => {
      for await (const _chunk of io.stdin) { /* drain input */ }
      for (let offset = 0; offset < bytes.length; offset += 65536) await io.stdout(bytes.subarray(offset, offset + 65536));
      return 0;
    } });
    const result = await client.exec({ op: 'exec', place: 'host', id: '123456abcdef', target: 'space', argv: ['cat'], keepTail: true, maxOutputBytes: 100000 });
    expect(result.stdout).toBe(bytes.subarray(-100000).toString('utf8'));
  });
  it('preserves stderr emitted immediately after stream acceptance', async () => {
    const client = await fixture({ request: async (_request, io) => { await io.stderr(Buffer.from('early diagnostic')); return 19; } });
    expect(await client.exec({ op: 'exec', place: 'host', id: '123456abcdef', target: 'space', argv: ['false'] })).toMatchObject({ code: 19, stdout: '', stderr: 'early diagnostic' });
  });
  it('drains a completed response when the caller starts reading after socket close', async () => {
    let sent;
    const completed = new Promise((resolve) => { sent = resolve; });
    const client = await fixture({ request: async (_request, io) => { await io.stdout(Buffer.from('complete')); setImmediate(sent); return 0; } });
    const stream = await client.attach({ op: 'attach', place: 'host', id: '123456abcdef' });
    await completed;
    await new Promise((resolve) => setImmediate(resolve));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('complete');
    expect(stream.exitCode).toBe(0);
  });
  it('keeps every byte when stdout backpressure delays the final exit frame', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 113);
    const client = await fixture({ request: async (_request, io) => {
      for (let offset = 0; offset < bytes.length; offset += 32768) await io.stdout(bytes.subarray(offset, offset + 32768));
      return 0;
    } });
    const stream = await client.attach({ op: 'attach', place: 'host', id: '123456abcdef' });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(stream.exitCode).toBe(0);
  });
  it('keeps a stream through a silence longer than an idle timeout its pool sets, as the HTTP agent does', async () => {
    // Given a relay whose far end answers only after a pause, as OpenCode's first shell does while it starts.
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    let disconnected = false;
    const client = await fixture({ request: async (_request, io) => {
      io.signal.addEventListener('abort', () => { disconnected = true; }, { once: true });
      await answered;
      await io.stdout(Buffer.from('late answer'));
      return 0;
    } });
    const stream = await client.attach({ op: 'attach', place: 'host', id: '123456abcdef' });
    // When the HTTP agent arms its idle timeout on the stream and the far end stays silent past it.
    stream.setTimeout(50);
    const timedOut = once(stream, 'timeout');
    await timedOut;
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer();
    // Then the stream is still open and carries the answer; hostd never saw the client leave.
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('late answer');
    expect(disconnected).toBe(false);
  });
  it('exposes socket methods and aborts the server-side stream when destroyed', async () => {
    let disconnected;
    const aborted = new Promise((resolve) => { disconnected = resolve; });
    const client = await fixture({ request: async (_request, io) => {
      io.signal.addEventListener('abort', disconnected, { once: true });
      await io.stdout(Buffer.from('ready'));
      await aborted;
      return 0;
    } });
    const stream = await client.attach({ op: 'attach', place: 'host', id: '123456abcdef' });
    expect((await once(stream, 'data'))[0].toString()).toBe('ready');
    for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref']) expect(stream[method]()).toBe(stream);
    expect(stream.setTimeout(0)).toBe(stream);
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    await aborted;
  });
});
