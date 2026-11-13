import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';

import { SherpaSegmentTranscriptionSession } from './sherpa-recognizer.js';

/**
 * Regression guard for the dictation timeout bug:
 * a segment's decode must NOT run inside the commit() call that the worker
 * acks. worker-process.js acks `session.commit` BEFORE decoding, which is only
 * correct if the session can hand the segment back without decoding it.
 *
 * If takePendingSegment() ever starts decoding inline again, a long segment
 * would block the worker's IPC past the parent's request timeout again — the
 * exact "Dictation worker request timed out: session.commit" failure.
 */

class RecordingEngine {
  constructor() {
    this.sampleRate = 16000;
    this.decoded = [];
    this.decodeCalls = 0;
  }
  decodePcm16(pcm16) {
    this.decodeCalls += 1;
    this.decoded.push(pcm16);
    return 'text';
  }
}

function pcm(seconds) {
  return Buffer.alloc(seconds * 16000 * 2, 1);
}

/** Square tone at `amplitude`, PCM16LE mono at 16 kHz. */
function tone(ms, amplitude) {
  const samples = Math.round((16000 * ms) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buffer;
}

function silence(ms) {
  return Buffer.alloc(Math.round((16000 * ms) / 1000) * 2);
}

describe('SherpaSegmentTranscriptionSession', () => {
  it('takePendingSegment does not decode; decodeSegment does', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    session.appendPcm16(pcm(5));
    const pending = session.takePendingSegment();

    // The whole point: handing back the segment must be decode-free.
    expect(engine.decodeCalls).toBe(0);
    expect(pending).not.toBeNull();
    expect(pending.pcm16.length).toBe(pcm(5).length);

    session.decodeSegment(pending);
    expect(engine.decodeCalls).toBe(1);
  });

  it('emits committed before the caller decodes', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    const events = [];
    session.on('committed', () => events.push('committed'));
    session.on('transcript', () => events.push('transcript'));

    session.appendPcm16(pcm(5));
    const pending = session.takePendingSegment();
    expect(events).toEqual(['committed']);
    expect(engine.decodeCalls).toBe(0);

    session.decodeSegment(pending);
    expect(events).toEqual(['committed', 'transcript']);
  });

  it('takePendingSegment returns null for an empty segment', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    const pending = session.takePendingSegment();
    expect(pending).toBeNull();
    expect(engine.decodeCalls).toBe(0);
  });

  it('decodes only the speech, with the silent tail trimmed', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    const speech = tone(500, 8000);
    session.appendPcm16(Buffer.concat([speech, silence(1000)]));
    session.decodeSegment(session.takePendingSegment());

    expect(engine.decodeCalls).toBe(1);
    const decodedMs = (engine.decoded[0].length / 2 / 16000) * 1000;
    expect(decodedMs).toBeGreaterThanOrEqual(580);
    expect(decodedMs).toBeLessThanOrEqual(620);
  });

  it('emits an empty final transcript instead of decoding pure silence', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    const transcripts = [];
    session.on('transcript', (event) => transcripts.push(event));

    session.appendPcm16(silence(1000));
    session.decodeSegment(session.takePendingSegment());

    expect(engine.decodeCalls).toBe(0);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].transcript).toBe('');
    expect(transcripts[0].isFinal).toBe(true);
  });

  it('starts a fresh segment so appended audio is not lost', async () => {
    const engine = new RecordingEngine();
    const session = new SherpaSegmentTranscriptionSession({ engine });
    await session.connect();

    session.appendPcm16(pcm(2));
    const first = session.takePendingSegment();

    session.appendPcm16(pcm(3));
    const second = session.takePendingSegment();

    expect(first.pcm16.length).toBe(pcm(2).length);
    expect(second.pcm16.length).toBe(pcm(3).length);
    expect(first.segmentId).not.toBe(second.segmentId);
  });
});
