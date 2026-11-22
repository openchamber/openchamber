import { describe, expect, it } from 'bun:test';

import {
  TunnelCodecError,
  TunnelFrameType,
  createFragmentAssembler,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeTunnelFrame,
  MAX_TUNNEL_PAYLOAD_BYTES,
} from './tunnel-codec.js';

describe('relay tunnel codec', () => {
  it('round-trips a frame', () => {
    const payload = new TextEncoder().encode('hello tunnel');
    const frame = encodeTunnelFrame(TunnelFrameType.HttpRequest, 7, payload);
    const decoded = decodeTunnelFrame(frame);
    expect(decoded.frameType).toBe(TunnelFrameType.HttpRequest);
    expect(decoded.streamId).toBe(7);
    expect(decoded.hasMoreFragments).toBe(false);
    expect(new TextDecoder().decode(decoded.payload)).toBe('hello tunnel');
  });

  it('preserves large stream ids without sign issues', () => {
    const frame = encodeTunnelFrame(TunnelFrameType.HttpBody, 0xfffffffd, new Uint8Array(0));
    expect(decodeTunnelFrame(frame).streamId).toBe(0xfffffffd);
  });

  it('rejects truncated and unknown frames', () => {
    expect(() => decodeTunnelFrame(new Uint8Array([1, 2]))).toThrow(TunnelCodecError);
    expect(() => decodeTunnelFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(TunnelCodecError);
  });

  it('fragments and reassembles oversized messages', () => {
    const big = new Uint8Array(MAX_TUNNEL_PAYLOAD_BYTES * 2 + 10);
    for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
    const frames = encodeFragmentedMessage(TunnelFrameType.WsBinary, 3, big);
    expect(frames.length).toBe(3);

    const assembler = createFragmentAssembler();
    let result = null;
    for (const frame of frames) {
      result = assembler.push(decodeTunnelFrame(frame));
    }
    expect(result).not.toBeNull();
    expect(Array.from(result)).toEqual(Array.from(big));
  });

  it('bounds fragment reassembly memory', () => {
    const assembler = createFragmentAssembler(MAX_TUNNEL_PAYLOAD_BYTES + 1);
    const chunk = new Uint8Array(MAX_TUNNEL_PAYLOAD_BYTES);
    // First fragment fits, second pushes past the cap.
    assembler.push({ frameType: TunnelFrameType.WsText, streamId: 1, payload: chunk, hasMoreFragments: true });
    expect(() =>
      assembler.push({ frameType: TunnelFrameType.WsText, streamId: 1, payload: chunk, hasMoreFragments: true }),
    ).toThrow(TunnelCodecError);
  });

  it('bounds aggregate pending bytes across distinct streams (#1024)', () => {
    // Per-message cap 100, aggregate cap 10: two 6-byte partials cannot both park.
    const assembler = createFragmentAssembler(100, 10);
    const fragment = (streamId, bytes, hasMoreFragments) => ({
      frameType: TunnelFrameType.WsText,
      streamId,
      payload: new Uint8Array(bytes),
      hasMoreFragments,
    });
    expect(assembler.push(fragment(1, 6, true))).toBeNull();
    expect(() => assembler.push(fragment(2, 6, true))).toThrow('fragmented messages exceed aggregate maximum size');
    // The offending key was discarded, not parked: its terminal fragment stands alone.
    expect(assembler.push(fragment(2, 3, false))).toEqual(new Uint8Array(3));
    // The surviving partial still completes at exactly the aggregate cap.
    expect(assembler.push(fragment(1, 4, false))).toEqual(new Uint8Array(10));
  });

  it('bounds the number of pending fragment keys (#1024)', () => {
    const assembler = createFragmentAssembler(100, 1000, 2);
    const fragment = (streamId, hasMoreFragments) => ({
      frameType: TunnelFrameType.WsText,
      streamId,
      payload: new Uint8Array([1]),
      hasMoreFragments,
    });
    expect(assembler.push(fragment(1, true))).toBeNull();
    expect(assembler.push(fragment(2, true))).toBeNull();
    expect(() => assembler.push(fragment(3, true))).toThrow('too many pending fragmented messages');
    // Existing keys are unaffected: one completes, freeing a key slot.
    expect(assembler.push(fragment(1, false))).toEqual(new Uint8Array([1, 1]));
    expect(assembler.push(fragment(3, true))).toBeNull();
  });
});
