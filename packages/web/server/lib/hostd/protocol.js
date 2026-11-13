import { Transform } from 'node:stream';
import { SpaceError } from '../spaces/errors.js';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const FRAME = Object.freeze({ CONTROL: 1, STDIN: 2, STDOUT: 3, STDERR: 4, STDIN_END: 5 });

export function frame(type, payload = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!Object.values(FRAME).includes(type) || bytes.length > MAX_FRAME_BYTES || (type === FRAME.STDIN_END && bytes.length !== 0)) {
    throw new SpaceError('invalid_frame', 'Invalid hostd frame type or length');
  }
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

export const controlFrame = (value) => frame(FRAME.CONTROL, JSON.stringify(value));

export function parseControl(payload) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new SpaceError('invalid_control', 'A control frame must contain UTF-8 JSON');
  }
}

// Bytes are bounded before allocation. Transform backpressure bounds queued frames too.
export class FrameDecoder extends Transform {
  #header = Buffer.alloc(5);
  #headerBytes = 0;
  #payload = null;
  #payloadBytes = 0;

  constructor() { super({ readableObjectMode: true }); }

  _transform(chunk, _encoding, done) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.#payload === null) {
          const count = Math.min(5 - this.#headerBytes, chunk.length - offset);
          chunk.copy(this.#header, this.#headerBytes, offset, offset + count);
          this.#headerBytes += count;
          offset += count;
          if (this.#headerBytes < 5) continue;
          const type = this.#header[0];
          const length = this.#header.readUInt32BE(1);
          if (type < 1 || type > 5 || length > MAX_FRAME_BYTES || (type === FRAME.STDIN_END && length !== 0)) {
            throw new SpaceError('invalid_frame', 'Invalid hostd frame type or length');
          }
          this.#payload = Buffer.alloc(length);
        }
        const count = Math.min(this.#payload.length - this.#payloadBytes, chunk.length - offset);
        chunk.copy(this.#payload, this.#payloadBytes, offset, offset + count);
        this.#payloadBytes += count;
        offset += count;
        if (this.#payloadBytes === this.#payload.length) {
          this.push({ type: this.#header[0], payload: this.#payload });
          this.#payload = null;
          this.#payloadBytes = 0;
          this.#headerBytes = 0;
        }
      }
      done();
    } catch (error) { done(error); }
  }

  _flush(done) {
    done(this.#headerBytes > 0 || this.#payload !== null ? new SpaceError('truncated_frame', 'The connection ended inside a frame') : null);
  }
}

export async function writeFrame(socket, type, payload) {
  await new Promise((resolve, reject) => socket.write(frame(type, payload), (error) => error ? reject(error) : resolve()));
}
