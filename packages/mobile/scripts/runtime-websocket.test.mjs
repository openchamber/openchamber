import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

test('native URLSession receives escaped terminal snapshots larger than 1 MiB', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const histories = ['\x1b[2K'.repeat(128 * 1024), '\x00'.repeat(512 * 1024)];
  const snapshots = histories.map((history) => JSON.stringify({
    t: 'snapshot', v: 3, s: 'terminal', q: 1, history, cols: 80, rows: 24, status: 'running',
  }));
  for (const snapshot of snapshots) {
    assert.ok(Buffer.byteLength(snapshot) > 1024 * 1024);
    assert.ok(Buffer.byteLength(snapshot) < 4 * 1024 * 1024);
  }
  const peers = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    for (const snapshot of snapshots) {
      const payload = Buffer.from(snapshot);
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      socket.write(Buffer.concat([header, payload]));
    }
  });
  const scratch = await mkdtemp(new URL('../.runtime-websocket-test-', import.meta.url));
  let child;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const factory = await readFile(new URL('../ios/App/App/RuntimeWebSocketTask.swift', import.meta.url), 'utf8');
    child = spawn('/usr/bin/swift', ['-module-cache-path', scratch, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    const finished = once(child, 'close');
    child.stdin.end(`${factory}
import Dispatch
let session = URLSession(configuration: .ephemeral)
let task = makeRuntimeWebSocketTask(session: session, request: URLRequest(url: URL(string: "ws://127.0.0.1:${server.address().port}/terminal")!))
precondition(task.state == .suspended)
precondition(task.maximumMessageSize <= 4 * 1024 * 1024)
task.resume()
Task {
    do {
        for expected in [String(repeating: "\\u{1b}[2K", count: 128 * 1024), String(repeating: "\\u{0}", count: 512 * 1024)] {
            guard case .string(let text) = try await task.receive(),
                  let snapshot = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  snapshot["history"] as? String == expected else { exit(2) }
            print(text.utf8.count)
        }
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        exit(0)
    } catch {
        fputs("Native receive failed: \\(error)\\n", stderr)
        exit(1)
    }
}
dispatchMain()
`);
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    try {
      const [code] = await finished;
      assert.equal(code, 0, errors);
      assert.deepEqual(output.trim().split('\n').map(Number), snapshots.map((snapshot) => Buffer.byteLength(snapshot)));
    } finally {
      clearTimeout(timer);
    }
  } finally {
    child?.kill('SIGKILL');
    for (const peer of peers) peer.destroy();
    server.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
