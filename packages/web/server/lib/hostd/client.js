import net from 'node:net';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import { SpaceError } from '../spaces/errors.js';
import { FRAME, MAX_FRAME_BYTES, FrameDecoder, controlFrame, frame, parseControl } from './protocol.js';

export const DEFAULT_SOCKET = '/run/openchamber-hostd/hostd.sock';

// hostd's `{ ok: false, code, message, details? }`, read from the socket. An answer that is no
// object at all gets both defaults, as one without the fields does.
const UNREADABLE = { code: 'hostd_answer_unreadable', message: 'hostd returned an invalid error', details: undefined };
const remoteErrorSchema = z.object({
  code: z.string().catch(UNREADABLE.code),
  message: z.string().catch(UNREADABLE.message),
  details: z.unknown(),
}).catch(UNREADABLE);
const remoteError = (answer) => {
  const { code, message, details } = remoteErrorSchema.parse(answer);
  return new SpaceError(code, message, details);
};
const connectionError = (error) => new SpaceError(error.code === 'ENOENT' ? 'hostd_missing' : 'hostd_unreachable', error.code === 'ENOENT' ? 'Install and enable the OpenChamber host daemon' : `The OpenChamber host daemon could not be reached (${error.code ?? 'connection failed'})`);

class HostdStream extends Duplex {
  #socket;
  #decoder;
  #finished = false;
  #stderr = Buffer.alloc(0);

  constructor(socket, decoder) {
    super({ allowHalfOpen: false });
    // The acceptance and first output frames may share one socket chunk. Hold output
    // until the caller has attached its stderr/exit listeners and starts reading.
    decoder.pause();
    this.#socket = socket;
    this.#decoder = decoder;
    this.on('error', () => {});
    socket.on('timeout', () => this.emit('timeout'));
    socket.on('error', (error) => this.destroy(connectionError(error)));
    decoder.on('error', (error) => this.destroy(error));
    decoder.on('data', ({ type, payload }) => {
      if (type === FRAME.STDOUT) { if (!this.push(payload)) decoder.pause(); return; }
      if (type === FRAME.STDERR) {
        this.#stderr = Buffer.concat([this.#stderr, payload]).subarray(-4096);
        this.emit('stderr', payload);
        return;
      }
      if (type !== FRAME.CONTROL) { this.destroy(new SpaceError('hostd_answer_unreadable', 'Unexpected hostd stream frame')); return; }
      try {
        const answer = parseControl(payload);
        if (answer?.ok === false) throw remoteError(answer);
        if (!Number.isInteger(answer?.exit) || answer.exit < 0 || answer.exit > 383) throw new SpaceError('hostd_answer_unreadable', 'Invalid hostd exit response');
        this.#finished = true;
        this.exitCode = answer.exit;
        this.emit('exit', answer.exit);
        if (answer.exit !== 0 && this.bridge) this.destroy(new SpaceError('command_stream_failed', `Space bridge exited ${answer.exit}: ${this.#stderr.toString('utf8')}`));
        else this.push(null);
      } catch (error) { this.destroy(error); }
    });
    // A socket may close while the paused decoder still holds stdout and its exit frame.
    // Judge completeness only after that readable side has drained.
    socket.on('close', () => { if (!decoder.writableEnded) decoder.end(); });
    decoder.once('end', () => { if (!this.#finished && !this.destroyed) this.destroy(new SpaceError('hostd_disconnected', 'hostd disconnected before the command ended')); });
  }

  _read() { this.#decoder.resume(); }
  _write(chunk, _encoding, done) {
    const write = (offset) => {
      if (offset >= chunk.length) { done(); return; }
      const end = Math.min(chunk.length, offset + MAX_FRAME_BYTES);
      this.#socket.write(frame(FRAME.STDIN, chunk.subarray(offset, end)), (error) => error ? done(error) : write(end));
    };
    write(0);
  }
  _final(done) { if (this.#finished) done(); else this.#socket.write(frame(FRAME.STDIN_END), done); }
  _destroy(error, done) { this.#decoder.destroy(); this.#socket.destroy(); done(error); }
  setNoDelay(value) { this.#socket.setNoDelay(value); return this; }
  setKeepAlive(value, delay) { this.#socket.setKeepAlive(value, delay); return this; }
  setTimeout(milliseconds, callback) {
    if (callback) { if (milliseconds > 0) this.once('timeout', callback); else this.removeListener('timeout', callback); }
    this.timeout = milliseconds;
    this.#socket.setTimeout(milliseconds);
    return this;
  }
  ref() { this.#socket.ref(); return this; }
  unref() { this.#socket.unref(); return this; }
}

export function createHostdClient({ socketPath = DEFAULT_SOCKET } = {}) {
  const open = (request, { stream = false, input, timeoutMs = 35 * 60_000 } = {}) => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new FrameDecoder();
    const fail = (error) => { socket.destroy(); decoder.destroy(); reject(error); };
    const connectError = (error) => fail(connectionError(error));
    socket.on('error', connectError);
    decoder.on('error', fail);
    const handshakeTimeout = () => fail(new SpaceError('hostd_timeout', 'hostd did not answer in time'));
    socket.setTimeout(timeoutMs, handshakeTimeout);
    socket.once('close', () => { if (!socket.answered) fail(new SpaceError('hostd_disconnected', 'hostd closed before answering')); });
    socket.pipe(decoder);
    decoder.once('data', ({ type, payload }) => {
      try {
        if (type !== FRAME.CONTROL) throw new SpaceError('hostd_answer_unreadable', 'hostd did not answer with a control frame');
        const answer = parseControl(payload);
        if (answer?.ok !== true) throw remoteError(answer ?? {});
        socket.answered = true;
        // With its listener: an idle timeout the HTTP agent later sets on a stream must not end it as this one.
        socket.setTimeout(0, handshakeTimeout);
        if (stream) {
          socket.removeListener('error', connectError);
          decoder.removeListener('error', fail);
          resolve(new HostdStream(socket, decoder));
        } else { socket.destroy(); resolve(answer.result); }
      } catch (error) { fail(error); }
    });
    socket.once('connect', () => {
      socket.write(controlFrame(request));
      if (input !== undefined) {
        let offset = 0;
        const next = () => {
          if (offset === input.length) { socket.write(frame(FRAME.STDIN_END)); return; }
          const end = Math.min(offset + MAX_FRAME_BYTES, input.length);
          const bytes = input.subarray(offset, end);
          offset = end;
          socket.write(frame(FRAME.STDIN, bytes), (error) => error ? fail(connectionError(error)) : next());
        };
        next();
      }
    });
  });
  return {
    socketPath,
    request: (request, options) => open(request, options),
    attach: (request) => open(request, { stream: true, timeoutMs: 60_000 }),
    exec: async (request, { stdin = '', signal } = {}) => {
      if (signal?.aborted) throw new SpaceError('command_aborted', 'The command was stopped by its caller');
      const channel = await open(request, { stream: true, timeoutMs: 60_000 });
      const stdout = [];
      let stderr = Buffer.alloc(0);
      let stdoutBytes = 0;
      const max = request.maxOutputBytes ?? 4 * 1024 * 1024;
      const abort = () => channel.destroy(new SpaceError('command_aborted', 'The command was stopped by its caller'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      channel.on('stderr', (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(-max); });
      channel.end(stdin);
      try {
        for await (const chunk of channel) {
          stdout.push(chunk); stdoutBytes += chunk.length;
          while (stdout.length > 1 && stdoutBytes - stdout[0].length >= max) stdoutBytes -= stdout.shift().length;
          if (stdoutBytes > max) { stdout[0] = stdout[0].subarray(stdoutBytes - max); stdoutBytes = max; }
        }
        return { code: channel.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr.toString('utf8') };
      } finally { signal?.removeEventListener('abort', abort); channel.destroy(); }
    },
  };
}
