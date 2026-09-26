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
 * (measured: 300s -> 115s decode) would block the worker's IPC past the
 * parent's request timeout again — the exact "Dictation worker request timed
 * out: session.commit" failure.
 */

class RecordingEngine {
  constructor() {
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
