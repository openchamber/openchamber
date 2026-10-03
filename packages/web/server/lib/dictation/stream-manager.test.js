import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'events';

import { DictationStreamManager } from './stream-manager.js';

const FORMAT = 'audio/pcm;rate=16000;bits=16';

class FakeSttSession extends EventEmitter {
  constructor({ transcriptBySegment = () => 'hello world' } = {}) {
    super();
    this.requiredSampleRate = 16000;
    this.appended = [];
    this.commits = 0;
    this.clears = 0;
    this.closed = false;
    this.segmentCounter = 0;
    this.transcriptBySegment = transcriptBySegment;
  }

  async connect() {}

  appendPcm16(buf) {
    this.appended.push(buf);
  }

  commit() {
    this.commits += 1;
    const segmentId = `seg-${this.segmentCounter}`;
    this.segmentCounter += 1;
    this.emit('committed', { segmentId, previousSegmentId: null });
    setTimeout(() => {
      this.emit('transcript', {
        segmentId,
        transcript: this.transcriptBySegment(segmentId),
        isFinal: true,
      });
    }, 0);
  }

  clear() {
    this.clears += 1;
  }

  close() {
    this.closed = true;
  }
}

function loudChunkBase64(samples = 1600, amplitude = 8000) {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(arr.buffer).toString('base64');
}

function silentChunkBase64(samples = 1600) {
  return Buffer.from(new Int16Array(samples).buffer).toString('base64');
}

/** Loud samples, then `gap` samples at `gapAmplitude` (silent by default), then loud again. */
function speechWithGapBase64({ before, gap, after, gapAmplitude = 0 }) {
  const arr = new Int16Array(before + gap + after);
  const fill = (start, count, amplitude) => {
    for (let i = start; i < start + count; i += 1) {
      arr[i] = i % 2 === 0 ? amplitude : -amplitude;
    }
  };
  fill(0, before, 8000);
  fill(before, gap, gapAmplitude);
  fill(before + gap, after, 8000);
  return Buffer.from(arr.buffer).toString('base64');
}

function createManager(session) {
  const messages = [];
  const manager = new DictationStreamManager({
    emit: (msg) => messages.push(msg),
    createSttSession: async () => ({ session }),
  });
  return { manager, messages };
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('DictationStreamManager', () => {
  it('transcribes ordered chunks and emits final text', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('hello world');
    expect(session.commits).toBe(1);
    expect(session.closed).toBe(true);

    const acks = messages.filter((m) => m.type === 'ack');
    expect(acks[acks.length - 1].payload.ackSeq).toBe(1);
  });

  it('reorders out-of-order chunks before appending', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(2);
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));
  });

  it('clears silence-only tails instead of committing', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64() });
    manager.handleFinish('d1', 0);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('');
    expect(session.commits).toBe(0);
    expect(session.clears).toBe(1);
  });

  it('fails fast when finish arrives with no chunks', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleFinish('d1', 3);

    const error = messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error.payload.retryable).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('reports provider readiness errors from createSttSession', async () => {
    const messages = [];
    const manager = new DictationStreamManager({
      emit: (msg) => messages.push(msg),
      createSttSession: async () => ({
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      }),
    });

    await manager.handleStart('d1', FORMAT, {});
    const error = messages.find((m) => m.type === 'error');
    expect(error.payload.reasonCode).toBe('model_download_in_progress');
    expect(error.payload.retryable).toBe(true);
  });

  it('emits partials as segment transcripts arrive', async () => {
    const session = new FakeSttSession({
      transcriptBySegment: (segmentId) => `part ${segmentId.slice('seg-'.length)}`,
    });
    const { manager, messages } = createManager(session);
    // Force a hard-cap split inside each ~0.1s chunk so several segments form.
    manager.segmentMaxSeconds = 0.05;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(1600) });
    await waitFor(() => session.commits >= 1);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64(1600) });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    // Two cap cuts plus the tail committed on finish.
    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('part 0 part 1 part 2');
    const partials = messages.filter((m) => m.type === 'partial');
    expect(partials.length).toBeGreaterThan(0);
  });

  it('keeps a short dictation as one segment even across pauses', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: silentChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: loudChunkBase64(16000) });

    expect(session.commits).toBe(0);

    manager.handleFinish('d1', 2);
    await waitFor(() => session.commits === 1);
  });

  it('splits at a pause once the segment passes the minimum length', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 3;

    await manager.handleStart('d1', FORMAT, {});
    // 2s of audio: below the minimum, so this pause must not split.
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: silentChunkBase64(16000) });
    expect(session.commits).toBe(0);

    // Past the minimum, the next quiet chunk is a segment boundary.
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 3, audioBase64: silentChunkBase64(16000) });
    expect(session.commits).toBe(1);
  });

  it('splits pauseless speech at the hard cap', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 60;
    manager.segmentMaxSeconds = 2;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(1);
  });

  it('cuts inside a pause, not at the chunk boundary', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 1;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    // 300 ms speech, 400 ms gap, 300 ms speech: the cut belongs in the gap.
    manager.handleChunk({
      dictationId: 'd1',
      seq: 1,
      audioBase64: speechWithGapBase64({ before: 4800, gap: 6400, after: 4800 }),
    });

    expect(session.commits).toBe(1);
    const cutBytes = session.appended[1].length;
    expect(cutBytes).toBeGreaterThan(4800 * 2);
    expect(cutBytes).toBeLessThan((4800 + 6400) * 2);
    // The rest of the chunk opens the next segment.
    expect(session.appended[2].length).toBe(16000 * 2 - cutBytes);
  });

  it('finds a pause that straddles two chunks', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 1;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    // 100 ms of quiet at the end of one chunk, 250 ms at the start of the next:
    // neither alone is a pause, together they are, and the middle of the
    // 350 ms run is 50 ms into the second chunk.
    manager.handleChunk({
      dictationId: 'd1',
      seq: 1,
      audioBase64: speechWithGapBase64({ before: 14400, gap: 1600, after: 0 }),
    });
    expect(session.commits).toBe(0);
    manager.handleChunk({
      dictationId: 'd1',
      seq: 2,
      audioBase64: speechWithGapBase64({ before: 0, gap: 4000, after: 12000 }),
    });

    expect(session.commits).toBe(1);
    expect(session.appended[2].length).toBe(800 * 2);
    expect(session.appended[3].length).toBe((16000 - 800) * 2);
  });

  it('forgets a silent first second so noisy pauses still count', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 12;

    await manager.handleStart('d1', FORMAT, {});
    // A gated mic opens with digital zeros; every later pause carries room noise.
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64(16000) });
    for (let seq = 1; seq <= 12; seq += 1) {
      manager.handleChunk({
        dictationId: 'd1',
        seq,
        audioBase64: speechWithGapBase64({ before: 4800, gap: 6400, after: 4800, gapAmplitude: 400 }),
      });
    }

    expect(session.commits).toBe(1);
    const cutBytes = session.appended[12].length;
    expect(cutBytes).toBeGreaterThan(4800 * 2);
    expect(cutBytes).toBeLessThan((4800 + 6400) * 2);
  });

  it('cuts at the quietest frame when the hard cap hits pauseless speech', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 60;
    manager.segmentMaxSeconds = 2;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    // A 50 ms dip 600 ms in: too short to be a pause, but the best place to cut.
    manager.handleChunk({
      dictationId: 'd1',
      seq: 1,
      audioBase64: speechWithGapBase64({ before: 9600, gap: 800, after: 5600, gapAmplitude: 2000 }),
    });

    expect(session.commits).toBe(1);
    expect(session.appended[1].length).toBe((9600 + 400) * 2);
  });

  it('clears a silence-only segment at the hard cap instead of committing it', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMaxSeconds = 1;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64(16000) });

    expect(session.commits).toBe(0);
    expect(session.clears).toBe(1);
  });
});
