import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import { DictationWorkerClient } from './worker-client.js';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.connected = true;
    this.killed = false;
  }

  send() {}
}

function createClient() {
  const worker = new FakeWorker();
  const client = new DictationWorkerClient({ forkWorker: () => worker });
  return { client, worker };
}

describe('DictationWorkerClient stderr', () => {
  it('preserves a multi-byte character split across chunks in the pending request error', async () => {
    const { client, worker } = createClient();
    const pending = client.sendRequest({ type: 'probe' }, { timeoutMs: 0 }).catch((error) => error);

    worker.stderr.emit('data', Buffer.concat([Buffer.from('worker failed: '), Buffer.from([0xe2, 0x82])]));
    worker.stderr.emit('data', Buffer.from([0xac]));
    worker.emit('close', 1, null);

    const error = await pending;
    expect(error.message).toBe('Dictation worker exited (code 1). Last stderr: worker failed: €');
  });

  it('flushes incomplete stderr bytes when the worker closes', async () => {
    const { client, worker } = createClient();
    const pending = client.sendRequest({ type: 'probe' }, { timeoutMs: 0 }).catch((error) => error);

    worker.stderr.emit('data', Buffer.concat([Buffer.from('worker failed: '), Buffer.from([0xe2, 0x82])]));
    worker.emit('close', 1, null);

    const error = await pending;
    expect(error.message).toBe('Dictation worker exited (code 1). Last stderr: worker failed: �');
  });

  it('keeps the 2,000-character tail bounded without splitting a surrogate pair', () => {
    const { client, worker } = createClient();
    client.ensureWorker();

    worker.stderr.emit('data', Buffer.from(`😀${'x'.repeat(1999)}`));

    expect(client.stderrTail).toBe('x'.repeat(1999));
    expect(client.stderrTail.length).toBeLessThanOrEqual(2000);
  });
});
