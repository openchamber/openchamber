import { fork } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DictationWorkerClient } from './worker-client.js';

const clientWithWorker = () => {
  const sent = [];
  const client = new DictationWorkerClient({ idleTtlMs: 60_000 });
  client.worker = { killed: false, connected: true, send: (message) => { sent.push(message); }, disconnect() {}, kill() {} };
  const answer = (result) => client.handleWorkerMessage({ type: 'response', requestId: sent.at(-1).requestId, ok: true, result });
  return { client, sent, answer };
};

describe('what the dictation client takes from its worker', () => {
  it('refuses synthesized audio that is not bytes', async () => {
    const { client, answer } = clientWithWorker();
    const refused = client.synthesizeSpeech({ modelsDir: '/m', modelId: 'kokoro-en-v0_19', text: 'Hi' });
    answer({ audio: 'not audio', format: 'audio/wav' });
    await expect(refused).rejects.toThrow('malformed result');

    const accepted = client.synthesizeSpeech({ modelsDir: '/m', modelId: 'kokoro-en-v0_19', text: 'Hi' });
    answer({ audio: new Uint8Array([1, 2]), format: 'audio/wav' });
    await expect(accepted).resolves.toEqual({ audio: Buffer.from([1, 2]), format: 'audio/wav' });
    client.shutdown();
  });

  it('settles a request the worker answers with a malformed reply', async () => {
    const { client, sent } = clientWithWorker();
    const cleared = client.sendRequest({ type: 'session.clear', sessionId: 's' }, { timeoutMs: 0 });
    client.handleWorkerMessage({ type: 'response', requestId: sent.at(-1).requestId, ok: null });
    await expect(cleared).rejects.toThrow('malformed response');
    expect(client.inFlightRequests).toBe(0);
    client.handleWorkerMessage({ type: 'response', requestId: 'nobody', ok: null });
    client.shutdown();
  });

  it('keeps the default sample rate when the worker names one that is not a number', async () => {
    const { client, answer } = clientWithWorker();
    const created = client.createSession({ modelsDir: '/m', modelId: 'parakeet-ultra-int8' }, new EventEmitter());
    answer({ requiredSampleRate: '48000' });
    expect((await created).requiredSampleRate).toBe(16000);
    client.shutdown();
  });

  it('turns a malformed session event into an error instead of forwarding it', async () => {
    const { client, answer } = clientWithWorker();
    const emitter = new EventEmitter();
    const seen = [];
    emitter.on('transcript', (payload) => seen.push(['transcript', payload]));
    emitter.on('error', (error) => seen.push(['error', error.message]));
    const created = client.createSession({ modelsDir: '/m', modelId: 'parakeet-ultra-int8' }, emitter);
    answer({ requiredSampleRate: 16000 });
    const { sessionId } = await created;

    client.handleWorkerMessage({ type: 'session.transcript', sessionId, payload: { segmentId: 's1', transcript: 'hello', isFinal: true } });
    client.handleWorkerMessage({ type: 'session.transcript', sessionId, payload: { segmentId: 's2', transcript: 7, isFinal: true } });
    expect(seen).toEqual([
      ['transcript', { segmentId: 's1', transcript: 'hello', isFinal: true }],
      ['error', 'Dictation worker sent a malformed transcript'],
    ]);
    client.shutdown();
  });
});

describe('a session whose worker is gone', () => {
  const openSession = async () => {
    const { client, answer } = clientWithWorker();
    const emitter = new EventEmitter();
    const errors = [];
    emitter.on('error', (error) => errors.push(error.message));
    const created = client.createSession({ modelsDir: '/m', modelId: 'parakeet-ultra-int8' }, emitter);
    answer({ requiredSampleRate: 16000 });
    return { client, errors, sessionId: (await created).sessionId };
  };

  it('closes without starting another worker', async () => {
    const { client, sessionId } = await openSession();
    client.handleWorkerExit(client.worker, 1, null);
    client.closeSession(sessionId);
    expect(client.worker).toBe(null);
  });

  it('fails, and lets the next worker go idle, when the exit was not reported yet', async () => {
    const { client, errors, sessionId } = await openSession();
    const dead = client.worker;
    client.appendSessionAudio(sessionId, Buffer.from([0, 0]));
    expect(client.inFlightRequests).toBe(1);
    dead.connected = false;
    client.appendSessionAudio(sessionId, Buffer.from([0, 0]));
    expect(client.worker).toBe(null);
    const synthesized = client.synthesizeSpeech({ modelsDir: '/m', modelId: 'missing', text: 'Hi' });
    await expect(synthesized).rejects.toThrow();
    client.handleWorkerExit(dead, 1, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('worker exited');
    expect(client.inFlightRequests).toBe(0);
    expect(client.sessionEmitters.size).toBe(0);
    expect(client.idleTimer).not.toBe(null);
    client.shutdown();
  }, 20_000);
});

describe('what the dictation worker takes from its parent', () => {
  let worker = null;
  afterEach(() => {
    worker?.kill();
    worker = null;
  });

  const ask = async (message) => {
    const answer = once(worker, 'message');
    worker.send(message);
    const [reply] = await answer;
    return reply;
  };

  it('refuses a request whose fields are not the protocol, and still answers a good one', async () => {
    worker = fork(fileURLToPath(new URL('./worker-process.js', import.meta.url)), [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    expect(await ask({ type: 'session.clear', requestId: 'r1', sessionId: 5 })).toEqual({
      type: 'response', requestId: 'r1', ok: false, error: 'Malformed dictation worker request: session.clear',
    });
    expect(await ask({ type: 'session.rewind', requestId: 'r2', sessionId: 's' })).toEqual({
      type: 'response', requestId: 'r2', ok: false, error: 'Unknown dictation worker request: session.rewind',
    });
    expect(await ask({ type: 'session.clear', requestId: 'r3', sessionId: 's' })).toEqual({ type: 'response', requestId: 'r3', ok: true });
    expect(await ask({ type: 'session.append', requestId: 'r4', sessionId: 's' })).toEqual({
      type: 'response', requestId: 'r4', ok: false, error: 'Unsupported audio payload in dictation worker',
    });
    expect(await ask({ type: 'session.append', requestId: 'r5', sessionId: 's', audio: Buffer.from([0, 0]) })).toEqual({ type: 'response', requestId: 'r5', ok: true });
  }, 20_000);
});
