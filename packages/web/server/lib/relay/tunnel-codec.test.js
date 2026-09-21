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
});
