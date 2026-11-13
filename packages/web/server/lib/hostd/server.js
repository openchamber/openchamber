import net from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SpaceError } from '../spaces/errors.js';
import { FRAME, FrameDecoder, controlFrame, parseControl, writeFrame } from './protocol.js';
import { MAX_FILL_BYTES, parseRequest } from './validation.js';

async function* inputFrames(iterator) {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new SpaceError('stdin_incomplete', 'hostd stdin ended without an end frame');
    if (next.value.type === FRAME.STDIN_END) return;
    if (next.value.type !== FRAME.STDIN) throw new SpaceError('invalid_frame_order', 'Only stdin frames may follow a request');
    yield next.value.payload;
  }
}

async function readFill(request, iterator, socket) {
  if (request.input !== null) return Buffer.from(request.input, 'base64');
  const chunks = [];
  let length = 0;
  const deadline = setTimeout(() => socket.destroy(new SpaceError('input_timeout', 'Tools input upload timed out')), 60_000);
  try {
    for await (const chunk of inputFrames(iterator)) {
      length += chunk.length;
      if (length > MAX_FILL_BYTES) throw new SpaceError('input_too_large', 'Tools input exceeds 64 MiB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally { clearTimeout(deadline); }
}

// What a failed request answers with, from whatever was thrown.
const failureSchema = z.object({ code: z.string().catch('hostd_failed'), message: z.unknown(), details: z.unknown() })
  .catch({ code: 'hostd_failed', message: undefined, details: undefined });

export function createHostdServer(daemon) {
  const connections = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= 64) { socket.end(controlFrame({ ok: false, code: 'hostd_busy', message: 'Too many hostd connections' })); return; }
    connections.add(socket);
    socket.on('error', () => {});
    const abort = new AbortController();
    // stdin has its own end frame. TCP EOF means the client left, even with allowHalfOpen.
    socket.once('end', () => { abort.abort(); socket.destroy(); });
    socket.once('close', () => { connections.delete(socket); abort.abort(); });
    const decoder = new FrameDecoder();
    const handshake = setTimeout(() => socket.destroy(), 10_000);
    socket.once('close', () => clearTimeout(handshake));
    socket.on('error', (error) => decoder.destroy(error));
    socket.on('close', () => decoder.destroy());
    socket.pipe(decoder);
    void (async () => {
      const iterator = decoder[Symbol.asyncIterator]();
      const first = await iterator.next();
      clearTimeout(handshake);
      if (first.done || first.value.type !== FRAME.CONTROL) throw new SpaceError('invalid_frame_order', 'The first hostd frame must be a control request');
      const request = parseRequest(parseControl(first.value.payload));
      const streamed = request.op === 'exec' || request.op === 'attach';
      const input = request.op === 'tools-ensure' ? await readFill(request, iterator, socket) : undefined;
      const io = { signal: abort.signal, stdin: Readable.from(inputFrames(iterator)), input,
        stdout: (bytes) => writeFrame(socket, FRAME.STDOUT, bytes), stderr: (bytes) => writeFrame(socket, FRAME.STDERR, bytes) };
      // Parsing and running checks belong to the daemon. An attach is accepted before command output.
      if (streamed) socket.write(controlFrame({ ok: true }));
      const result = await daemon.request(request, io);
      socket.end(controlFrame(streamed ? { exit: result } : { ok: true, result: result ?? null }));
    })().catch((error) => {
      const { code, message, details } = failureSchema.parse(error);
      // JSON leaves `details` out when it is undefined.
      if (!socket.destroyed) socket.end(controlFrame({ ok: false, code, message: String(message ?? 'hostd failed').slice(0, 2000), details }));
    });
  });
  return { server, close: async () => { for (const socket of connections) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
