import { describe, expect, test } from 'bun:test';
import { createDownstreamScheduler, DOWNSTREAM_CHUNK_BYTES } from './downstream-scheduler.js';
import { encodeTunnelFrame, decodeTunnelFrame, TunnelFrameType } from './tunnel-codec.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const body = (streamId, value = 0, size = DOWNSTREAM_CHUNK_BYTES) =>
  encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, new Uint8Array(size).fill(value));

function fixture() {
  const sent = [];
  const errors = [];
  let time = 0;
  const scheduler = createDownstreamScheduler({
    sendBatch: async frames => { sent.push(...frames); },
    onError: error => errors.push(error.message),
    now: () => time,
  });
  return { scheduler, sent, errors, advance: ms => { time += ms; } };
}

describe('relay downstream scheduling', () => {
  test('stops without end-client ACKs even when the relay socket accepts everything', async () => {
    const { scheduler, sent } = fixture();
    const pending = Array.from({ length: 100 }, () => scheduler.send(body(1)));
    await tick();
    const bytes = sent.reduce((sum, frame) => sum + frame.length, 0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(bytes).toBeGreaterThan(48 * 1024);
    await tick();
    expect(sent.reduce((sum, frame) => sum + frame.length, 0)).toBe(bytes);
    scheduler.acknowledge(bytes);
    await tick();
    expect(sent.reduce((sum, frame) => sum + frame.length, 0)).toBeGreaterThan(bytes);
    scheduler.close();
    await Promise.all(pending);
  });

  test('rotates streams while preserving every delta and each stream end', async () => {
    const { scheduler, sent } = fixture();
    const pending = [];
    for (let value = 0; value < 3; value++) pending.push(scheduler.send(body(1, value)));
    pending.push(scheduler.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array())));
    pending.push(scheduler.send(body(3, 99, 10)));
    await Promise.all(pending);
    expect(sent.map(frame => decodeTunnelFrame(frame).streamId)).toEqual([1, 3, 1, 1, 1]);
    expect(sent.filter(frame => decodeTunnelFrame(frame).streamId === 1).map(frame => decodeTunnelFrame(frame).payload[0])).toEqual([0, 1, 2, undefined]);
    scheduler.close();
  });

  test('keepalives bypass credit; cancellation and close release blocked producers', async () => {
    const { scheduler, sent } = fixture();
    const pending = Array.from({ length: 20 }, () => scheduler.send(body(1)));
    await tick();
    const before = sent.length;
    await scheduler.send(encodeTunnelFrame(TunnelFrameType.Pong, 0, new Uint8Array()));
    expect(sent.length).toBe(before + 1);
    scheduler.cancel(1);
    await Promise.all(pending);
    const blocked = scheduler.send(body(3));
    scheduler.close();
    await blocked;
    // Teardown makes late ACKs harmless.
    scheduler.acknowledge(123);
  });

  test('rejects forged, replayed, regressing and partial-frame ACKs', async () => {
    const { scheduler, sent } = fixture();
    await scheduler.send(body(1));
    const bytes = sent[0].length;
    for (const value of [0, -1, 1, bytes + 1, NaN, Infinity]) {
      expect(() => scheduler.acknowledge(value)).toThrow();
    }
    scheduler.acknowledge(bytes);
    expect(() => scheduler.acknowledge(bytes)).toThrow();
    scheduler.close();
  });

  test('bounds pending memory and reports overflow instead of silently dropping deltas', async () => {
    const { scheduler, errors } = fixture();
    const pending = Array.from({ length: 600 }, () => scheduler.send(body(1)));
    await Promise.all(pending);
    expect(errors).toEqual(['relay downstream queue limit exceeded']);
  });

  test('send failure settles selected and queued producers', async () => {
    const errors = [];
    const scheduler = createDownstreamScheduler({
      sendBatch: async () => { throw new Error('wire failed'); },
      onError: error => errors.push(error.message),
    });
    await Promise.all([scheduler.send(body(1)), scheduler.send(body(3))]);
    expect(errors).toEqual(['wire failed']);
  });

  test('teardown releases a producer even while encryption is still pending', async () => {
    let release;
    let started = false;
    const scheduler = createDownstreamScheduler({
      sendBatch: () => new Promise(resolve => { started = true; release = resolve; }),
      onError: error => { throw error; },
    });
    const pending = scheduler.send(body(1));
    await tick();
    expect(started).toBe(true);
    scheduler.close();
    await pending;
    release();
    await tick();
  });

  test('sparse traffic cannot inflate the window for a later bulk burst', async () => {
    const { scheduler, sent, advance } = fixture();
    let acknowledged = 0;
    for (let i = 0; i < 100; i++) {
      const frame = body(1);
      await scheduler.send(frame);
      advance(50);
      acknowledged += frame.length;
      scheduler.acknowledge(acknowledged);
    }
    const before = sent.length;
    const pending = Array.from({ length: 100 }, () => scheduler.send(body(1)));
    await tick();
    expect(sent.slice(before).reduce((sum, frame) => sum + frame.length, 0)).toBeLessThanOrEqual(64 * 1024);
    scheduler.close();
    await Promise.all(pending);
  });

  test('adapts to a clear high-RTT path, then contracts when delivery backs up', async () => {
    const { scheduler, sent, advance, errors } = fixture();
    let acknowledged = 0;
    let maxFlight = 0;
    const pending = Array.from({ length: 400 }, () => scheduler.send(body(1)));
    for (let round = 0; round < 12; round++) {
      // Keep enough queued output to exercise growth all the way to the cap.
      while (pending.length < sent.length + 400) pending.push(scheduler.send(body(1)));
      await tick();
      const delivered = sent.reduce((sum, frame) => sum + frame.length, 0);
      maxFlight = Math.max(maxFlight, delivered - acknowledged);
      expect(delivered - acknowledged).toBeLessThanOrEqual(1024 * 1024);
      advance(200);
      scheduler.acknowledge(delivered);
      acknowledged = delivered;
    }
    // Reach the cap with a backlogged sender, allowing for whole-frame sizing.
    expect(maxFlight).toBeGreaterThan(1024 * 1024 - body(1).length);
    // Keep the sender backlogged while ACK latency jumps to a second.
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 30; i++) pending.push(scheduler.send(body(1)));
      await tick();
      const delivered = sent.reduce((sum, frame) => sum + frame.length, 0);
      advance(1000);
      scheduler.acknowledge(delivered);
      acknowledged = delivered;
    }
    await tick();
    expect(sent.reduce((sum, frame) => sum + frame.length, 0) - acknowledged).toBeLessThanOrEqual(64 * 1024);
    expect(errors).toEqual([]);
    scheduler.close();
    await Promise.all(pending);
  });
});
