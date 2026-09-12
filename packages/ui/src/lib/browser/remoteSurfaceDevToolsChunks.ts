import {
  DEVTOOLS_CHUNK_BYTES, DEVTOOLS_COMMAND_BYTES, DEVTOOLS_MESSAGE_BYTES, DEVTOOLS_TIMEOUT_MS,
  type DevToolsChunk, type DevToolsChunkAck, type DevToolsCommand, type DevToolsErrorCode,
} from './remoteSurfaceDevToolsProtocol';

type Sending = {
  bytes: Uint8Array;
  sent: number;
  acknowledged: number;
  timer: ReturnType<typeof setTimeout> | null;
};
type Receiving = { bytes: Uint8Array; count: number; next: number; timer: ReturnType<typeof setTimeout> };

const MAX_QUEUED_COMMANDS = 1_024;
const MAX_QUEUED_COMMAND_BYTES = 24 * 1024 * 1024;

export class RemoteSurfaceDevToolsChunks {
  private readonly outgoing = new Map<string, Sending>();
  private readonly incoming = new Map<string, Receiving>();
  private sendBytes = 0;
  private receiveBytes = 0;
  private sequence = 0;
  private stopped = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly devtoolsId: string,
    private readonly send: (command: DevToolsCommand) => boolean,
    private readonly deliver: (message: string) => void,
    private readonly onError: (code: DevToolsErrorCode) => void,
  ) {}

  sendMessage(message: string): void {
    if (this.stopped) return;
    if (message.length > DEVTOOLS_COMMAND_BYTES) { this.fail('DEVTOOLS_MESSAGE_TOO_LARGE'); return; }
    const bytes = new TextEncoder().encode(message);
    if (!bytes.length || bytes.length > DEVTOOLS_COMMAND_BYTES) { this.fail('DEVTOOLS_MESSAGE_TOO_LARGE'); return; }
    if (this.outgoing.size >= MAX_QUEUED_COMMANDS
      || this.sendBytes + bytes.length > MAX_QUEUED_COMMAND_BYTES) {
      this.fail('DEVTOOLS_BACKPRESSURE'); return;
    }
    const messageId = `command-${++this.sequence}`;
    this.outgoing.set(messageId, { bytes, sent: 0, acknowledged: -1, timer: null });
    this.sendBytes += bytes.length;
    this.schedulePump();
  }

  acknowledge(ack: DevToolsChunkAck): void {
    if (this.stopped || ack.devtoolsId !== this.devtoolsId || ack.direction !== 'command') return;
    const entry = this.outgoing.get(ack.messageId);
    if (!entry) return;
    if (ack.index >= entry.sent) { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    if (ack.index <= entry.acknowledged) return;
    entry.acknowledged = ack.index;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (ack.index + 1 === Math.ceil(entry.bytes.length / DEVTOOLS_CHUNK_BYTES)) {
      this.outgoing.delete(ack.messageId);
      this.sendBytes -= entry.bytes.length;
    }
    this.schedulePump();
  }

  receive(chunk: DevToolsChunk): void {
    if (this.stopped || chunk.devtoolsId !== this.devtoolsId) return;
    if (chunk.count !== Math.ceil(chunk.byteLength / DEVTOOLS_CHUNK_BYTES) || chunk.index >= chunk.count) {
      this.fail('DEVTOOLS_INVALID_REQUEST'); return;
    }
    let binary: string;
    try {
      binary = atob(chunk.data);
      if (btoa(binary) !== chunk.data) { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    } catch { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    const expected = Math.min(DEVTOOLS_CHUNK_BYTES, chunk.byteLength - chunk.index * DEVTOOLS_CHUNK_BYTES);
    if (binary.length !== expected) { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    let entry = this.incoming.get(chunk.messageId);
    if (!entry) {
      if (chunk.index !== 0 || this.incoming.size >= 2
        || this.receiveBytes + chunk.byteLength > DEVTOOLS_MESSAGE_BYTES) {
        this.fail('DEVTOOLS_BACKPRESSURE'); return;
      }
      entry = { bytes: new Uint8Array(chunk.byteLength), count: chunk.count, next: 0, timer: this.deadline() };
      this.incoming.set(chunk.messageId, entry);
      this.receiveBytes += chunk.byteLength;
    }
    if (entry.next !== chunk.index || entry.count !== chunk.count || entry.bytes.length !== chunk.byteLength) {
      this.fail('DEVTOOLS_INVALID_REQUEST'); return;
    }
    for (let index = 0; index < binary.length; index++) {
      entry.bytes[chunk.index * DEVTOOLS_CHUNK_BYTES + index] = binary.charCodeAt(index);
    }
    entry.next++;
    clearTimeout(entry.timer);
    const complete = entry.next === entry.count;
    if ((chunk.index + 1) % 4 === 0 || complete) {
      if (!this.send({ type: 'devtoolsChunkAck', devtoolsId: this.devtoolsId,
        direction: 'message', messageId: chunk.messageId, index: chunk.index })) {
        this.fail('DEVTOOLS_CONNECTION_CLOSED'); return;
      }
    }
    if (!complete) { entry.timer = this.deadline(); return; }
    this.incoming.delete(chunk.messageId);
    this.receiveBytes -= entry.bytes.length;
    try { this.deliver(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)); }
    catch { this.fail('DEVTOOLS_INVALID_REQUEST'); }
  }

  dispose(): void {
    this.stopped = true;
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    for (const entry of this.outgoing.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    for (const entry of this.incoming.values()) clearTimeout(entry.timer);
    this.outgoing.clear();
    this.incoming.clear();
    this.sendBytes = 0;
    this.receiveBytes = 0;
  }

  private deadline(): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.fail('DEVTOOLS_BACKPRESSURE'), DEVTOOLS_TIMEOUT_MS);
  }

  private schedulePump(): void {
    if (this.stopped || this.pumpTimer !== null) return;
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, 0);
  }

  private pump(): void {
    let active = 0;
    for (const [messageId, entry] of this.outgoing) {
      if (active++ === 2) break;
      const count = Math.ceil(entry.bytes.length / DEVTOOLS_CHUNK_BYTES);
      while (!this.stopped && entry.sent < count && entry.sent - entry.acknowledged <= 8) {
        const index = entry.sent++;
        const bytes = entry.bytes.subarray(index * DEVTOOLS_CHUNK_BYTES, (index + 1) * DEVTOOLS_CHUNK_BYTES);
        const data = btoa(String.fromCharCode(...bytes));
        if (!this.send({ type: 'devtoolsCommandChunk', devtoolsId: this.devtoolsId, messageId,
          index, count, byteLength: entry.bytes.length, data })) {
          this.fail('DEVTOOLS_CONNECTION_CLOSED'); return;
        }
      }
      if (entry.sent > entry.acknowledged + 1 && entry.timer === null) entry.timer = this.deadline();
    }
  }

  private fail(code: DevToolsErrorCode): void {
    if (this.stopped) return;
    this.dispose();
    this.onError(code);
  }
}
