import { afterEach, describe, it, expect, vi } from 'vitest';
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
  it('uses longer segments for OpenAI-compatible dictation while keeping local bounds', async () => {
    const local = new FakeSttSession();
    const cloud = new FakeSttSession();
    const manager = new DictationStreamManager({
      emit: () => {},
      createSttSession: async (options) => ({ session: options.provider === 'openai-compatible' ? cloud : local }),
    });
    await manager.handleStart('local', FORMAT, {});
    await manager.handleStart('cloud', FORMAT, { provider: 'openai-compatible' });
    const audio = loudChunkBase64(16000);
    for (let seq = 0; seq < 30; seq += 1) {
      for (const dictationId of ['local', 'cloud']) {
        manager.handleChunk({ dictationId, seq, audioBase64: audio });
      }
    }
    expect(local.commits).toBe(1);
    expect(cloud.commits).toBe(0);
    manager.cleanupAll();
  });

  it('cuts OpenAI-compatible audio at a pause after 60 seconds or at the 120-second cap', async () => {
    for (const withPause of [true, false]) {
      const session = new FakeSttSession();
      const { manager } = createManager(session);
      await manager.handleStart('cloud', FORMAT, { provider: 'openai-compatible' });
      const audio = loudChunkBase64(16000);
      const duration = withPause ? 60 : 119;
      for (let seq = 0; seq < duration; seq += 1) {
        manager.handleChunk({ dictationId: 'cloud', seq, audioBase64: audio });
      }
      expect(session.commits).toBe(0);
      const last = withPause
        ? speechWithGapBase64({ before: 4000, gap: 4000, after: 8000 })
        : audio;
      manager.handleChunk({ dictationId: 'cloud', seq: duration, audioBase64: last });
      expect(session.commits).toBe(1);
      manager.cleanupAll();
    }
  });

  it('budgets finalization for the duration of a committed long segment', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);
    await manager.handleStart('cloud', FORMAT, { provider: 'openai-compatible' });
    const audio = loudChunkBase64(16000);
    for (let seq = 0; seq < 59; seq += 1) {
      manager.handleChunk({ dictationId: 'cloud', seq, audioBase64: audio });
    }
    manager.handleFinish('cloud', 58);
    expect(messages.find((message) => message.type === 'finish_accepted').payload.timeoutMs).toBeGreaterThanOrEqual(98500);
    manager.cleanupAll();
  });

  it('retains unchecked segment keys and joins unchecked transcript values', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);
    await manager.handleStart('d1', FORMAT, {});

    const segmentId = { id: 'segment' };
    session.emit('committed', { segmentId });
    session.emit('transcript', { segmentId, transcript: 42, isFinal: 'yes' });
    manager.handleFinish('d1', -1);

    expect(messages.find((message) => message.type === 'final').payload.text).toBe('42');
    expect(session.closed).toBe(true);
  });

  it('passes an unchecked language hint to correction unchanged', async () => {
    const session = new FakeSttSession();
    const messages = [];
    const language = { hint: 'uk' };
    let correctionOptions;
    const manager = new DictationStreamManager({
      emit: (message) => messages.push(message),
      createSttSession: async () => ({ session }),
      correctTranscript: async (text, options) => {
        correctionOptions = options;
        return text;
      },
    });
    await manager.handleStart('d1', FORMAT, { correct: true, language });
    session.emit('committed', { segmentId: 'segment' });
    session.emit('transcript', { segmentId: 'segment', transcript: 'hello', isFinal: true });
    manager.handleFinish('d1', -1);

    await waitFor(() => messages.some((message) => message.type === 'final'));
    expect(correctionOptions.language).toBe(language);
  });

  it('retains inherited, non-string rejection messages', async () => {
    const message = { code: 'provider_failure' };
    const messages = [];
    const manager = new DictationStreamManager({
      emit: (event) => messages.push(event),
      createSttSession: async () => {
        throw Object.create({ message });
      },
    });
    await manager.handleStart('d1', FORMAT, {});
    expect(messages.find((event) => event.type === 'error').payload.error).toBe(message);
  });

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

  describe('a stream nobody sends audio to', () => {
    afterEach(() => vi.useRealTimers());

    it('is released after the idle limit, with a reason the client can replay on', async () => {
      vi.useFakeTimers();
      const session = new FakeSttSession();
      const { manager, messages } = createManager(session);
      await manager.handleStart('d1', FORMAT, {});
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      vi.advanceTimersByTime(5 * 60_000 - 1);
      expect(session.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(session.closed).toBe(true);
      expect(manager.streams.size).toBe(0);
      expect(messages.at(-1).payload).toMatchObject({ retryable: true, reasonCode: 'stream_released' });
      manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
      expect(messages.at(-1).payload.reasonCode).toBe('stream_released');
    });

    it('stays open through a long silence, because silent chunks keep arriving', async () => {
      vi.useFakeTimers();
      const session = new FakeSttSession();
      const { manager } = createManager(session);
      await manager.handleStart('d1', FORMAT, {});
      for (let seq = 0; seq < 1200; seq += 1) {
        manager.handleChunk({ dictationId: 'd1', seq, audioBase64: silentChunkBase64(160) });
        vi.advanceTimersByTime(1000);
      }
      expect(session.closed).toBe(false);
      manager.handleCancel('d1');
    });

    it('ignores what an earlier session of the same id reports late', async () => {
      const sessions = [new FakeSttSession(), new FakeSttSession()];
      const messages = [];
      const manager = new DictationStreamManager({
        emit: (message) => messages.push(message),
        createSttSession: async (options) => ({ session: sessions[options.localModel] }),
      });
      await manager.handleStart('d1', FORMAT, { localModel: 0 });
      await manager.handleStart('d1', FORMAT, { localModel: 1 });
      sessions[0].emit('error', new Error('late'));
      sessions[0].emit('transcript', { segmentId: 'old', transcript: 'old', isFinal: true });
      expect(messages.map((message) => message.type)).toEqual(['ack', 'ack']);
      expect(sessions[1].closed).toBe(false);
      manager.cleanupAll();
    });

    it('is resumed within the limit and then counts from the resume', async () => {
      vi.useFakeTimers();
      const session = new FakeSttSession();
      const { manager } = createManager(session);
      await manager.handleStart('d1', FORMAT, {});
      vi.advanceTimersByTime(4 * 60_000);
      await manager.handleStart('d1', FORMAT, {});
      vi.advanceTimersByTime(4 * 60_000);
      expect(session.closed).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(session.closed).toBe(true);
    });
  });

  describe('resume after a reconnect', () => {
    const OPTIONS = {
      provider: 'local',
      localModel: 'parakeet',
      language: 'de',
      correct: false,
    };

    function createResumingManager() {
      const sessions = [];
      const messages = [];
      const manager = new DictationStreamManager({
        emit: (msg) => messages.push(msg),
        createSttSession: async () => {
          const session = new FakeSttSession();
          sessions.push(session);
          return { session };
        },
      });
      return { manager, messages, sessions };
    }

    const lastAck = (messages) =>
      [...messages].reverse().find((message) => message.type === 'ack');

    it('continues an existing stream without a new session or replayed audio', async () => {
      const { manager, messages, sessions } = createResumingManager();

      await manager.handleStart('d1', FORMAT, OPTIONS);
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
      const appendedBefore = sessions[0].appended.length;
      expect(appendedBefore).toBe(2);

      await manager.handleStart('d1', FORMAT, OPTIONS);

      expect(sessions.length).toBe(1);
      expect(sessions[0].closed).toBe(false);
      expect(sessions[0].appended.length).toBe(appendedBefore);
      expect(lastAck(messages).payload.ackSeq).toBe(1);

      manager.handleCancel('d1');
    });

    it('starts a new stream when the decoding options changed', async () => {
      const { manager, messages, sessions } = createResumingManager();

      await manager.handleStart('d1', FORMAT, OPTIONS);
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      await manager.handleStart('d1', FORMAT, { ...OPTIONS, localModel: 'other-model' });

      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(lastAck(messages).payload.ackSeq).toBe(-1);

      manager.handleCancel('d1');
    });

    it('starts a new stream when only the transcription prompt changed', async () => {
      const { manager, messages, sessions } = createResumingManager();
      const compatible = {
        provider: 'openai-compatible',
        openaiCompatible: { baseUrl: 'http://stt.local', model: 'whisper', prompt: 'Names: Ada' },
      };

      await manager.handleStart('d1', FORMAT, compatible);
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      await manager.handleStart('d1', FORMAT, {
        ...compatible,
        openaiCompatible: { ...compatible.openaiCompatible, prompt: 'Names: Grace' },
      });

      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(lastAck(messages).payload.ackSeq).toBe(-1);

      manager.handleCancel('d1');
    });

    it('resumes a stream that already sealed its finish, until final goes out', async () => {
      const { manager, messages, sessions } = createResumingManager();

      await manager.handleStart('d1', FORMAT, OPTIONS);
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      manager.handleFinish('d1', 0);
      expect(manager.streams.get('d1')?.finishSealed).toBe(true);

      await manager.handleStart('d1', FORMAT, OPTIONS);

      // The stream lives until `final`. A client that lost the socket between
      // `finish` and `final` must not get an empty new stream: that would
      // throw its finished audio away.
      expect(sessions.length).toBe(1);
      expect(sessions[0].closed).toBe(false);
      expect(lastAck(messages).payload.ackSeq).toBe(0);

      await waitFor(() => messages.some((m) => m.type === 'final'));
      expect(messages.find((m) => m.type === 'final').payload.text).toBe('hello world');
      expect(sessions[0].closed).toBe(true);
    });

    it('treats a repeated finish as a renewal: two acceptances, one final', async () => {
      const { manager, messages, sessions } = createResumingManager();

      await manager.handleStart('d1', FORMAT, OPTIONS);
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      manager.handleFinish('d1', 0);
      manager.handleFinish('d1', 0);

      await waitFor(() => messages.some((m) => m.type === 'final'));

      expect(messages.filter((m) => m.type === 'finish_accepted').length).toBe(2);
      expect(messages.filter((m) => m.type === 'final').length).toBe(1);
      // The tail was committed once, not twice.
      expect(sessions[0].commits).toBe(1);
      expect(sessions[0].closed).toBe(true);
    });

    function createSlowManager() {
      const sessions = [];
      const pending = [];
      const messages = [];
      const manager = new DictationStreamManager({
        emit: (msg) => messages.push(msg),
        // Holds every session until the test releases it, like a local model
        // that takes seconds to load.
        createSttSession: () => new Promise((resolve) => {
          const session = new FakeSttSession();
          sessions.push(session);
          pending.push(() => resolve({ session }));
        }),
      });
      const releaseAll = () => pending.splice(0).forEach((release) => release());
      return { manager, messages, sessions, releaseAll };
    }

    it('answers a start repeated while the session loads with the loading session', async () => {
      const { manager, messages, sessions, releaseAll } = createSlowManager();

      const first = manager.handleStart('d1', FORMAT, OPTIONS);
      const repeated = manager.handleStart('d1', FORMAT, OPTIONS);
      releaseAll();
      await Promise.all([first, repeated]);

      expect(sessions.length).toBe(1);
      expect(manager.streams.get('d1')?.stt).toBe(sessions[0]);
      expect(messages.filter((m) => m.type === 'ack').map((m) => m.payload.ackSeq)).toEqual([-1]);

      manager.handleCancel('d1');
    });

    it('closes a session that finishes loading after its dictation was cancelled', async () => {
      const { manager, messages, sessions, releaseAll } = createSlowManager();

      const start = manager.handleStart('d1', FORMAT, OPTIONS);
      manager.handleCancel('d1');
      releaseAll();
      await start;

      expect(sessions[0].closed).toBe(true);
      expect(manager.streams.has('d1')).toBe(false);
      expect(messages.some((m) => m.type === 'ack')).toBe(false);
    });

    it('closes the loading session when a start with other options replaces it', async () => {
      const { manager, sessions, releaseAll } = createSlowManager();

      const first = manager.handleStart('d1', FORMAT, OPTIONS);
      const replaced = manager.handleStart('d1', FORMAT, { ...OPTIONS, localModel: 'other-model' });
      releaseAll();
      await Promise.all([first, replaced]);

      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(manager.streams.get('d1')?.stt).toBe(sessions[1]);

      manager.handleCancel('d1');
    });
  });

  describe('correction pass', () => {
    const dictate = async ({ correct, correctTranscript }) => {
      const session = new FakeSttSession({ transcriptBySegment: () => 'таку з дибав' });
      const messages = [];
      const manager = new DictationStreamManager({
        emit: (msg) => messages.push(msg),
        createSttSession: async () => ({ session }),
        correctTranscript,
      });
      await manager.handleStart('d1', FORMAT, { correct, language: 'uk' });
      manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
      manager.handleFinish('d1', 0);
      return { manager, messages, session };
    };

    it('sends the corrected text as final when the start options ask for it', async () => {
      const calls = [];
      const { messages, session } = await dictate({
        correct: true,
        correctTranscript: async (text, options) => {
          calls.push({ text, options });
          return 'такий і здибав';
        },
      });
      await waitFor(() => messages.some((m) => m.type === 'final'));
      expect(messages.find((m) => m.type === 'final').payload.text).toBe('такий і здибав');
      expect(calls).toEqual([{ text: 'таку з дибав', options: { language: 'uk' } }]);
      expect(session.closed).toBe(true);
    });

    it('leaves the text alone without the start option', async () => {
      let called = false;
      const { messages } = await dictate({ correct: false, correctTranscript: async () => { called = true; return 'x'; } });
      await waitFor(() => messages.some((m) => m.type === 'final'));
      expect(messages.find((m) => m.type === 'final').payload.text).toBe('таку з дибав');
      expect(called).toBe(false);
    });

    it('keeps the dictation when the correction fails', async () => {
      const { messages } = await dictate({ correct: true, correctTranscript: async () => { throw new Error('boom'); } });
      await waitFor(() => messages.some((m) => m.type === 'final'));
      expect(messages.find((m) => m.type === 'final').payload.text).toBe('таку з дибав');
    });

    it('emits nothing after a cancel during the correction', async () => {
      let release;
      const { manager, messages } = await dictate({
        correct: true,
        correctTranscript: () => new Promise((resolve) => { release = resolve; }),
      });
      await waitFor(() => release !== undefined);
      manager.handleCancel('d1');
      release('late');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages.some((m) => m.type === 'final')).toBe(false);
    });
  });
});
