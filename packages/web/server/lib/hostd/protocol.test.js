import { describe, expect, it } from 'vitest';
import { FRAME, MAX_FRAME_BYTES, FrameDecoder, controlFrame, frame, parseControl } from './protocol.js';

const decode = async (chunks) => {
  const decoder = new FrameDecoder();
  const result = [];
  const reading = (async () => { for await (const entry of decoder) result.push(entry); return result; })();
  for (const chunk of chunks) decoder.write(chunk);
  decoder.end();
  return reading;
};

describe('hostd framing', () => {
  it('decodes fragmented and coalesced frames without changing bytes', async () => {
    // Given binary stdin, including NUL and invalid UTF-8, beside JSON and an end frame.
    const bytes = Buffer.concat([controlFrame({ op: 'check' }), frame(FRAME.STDIN, Buffer.from([0, 255, 3])), frame(FRAME.STDIN_END)]);
    // When every byte arrives separately.
    const answer = await decode([...bytes].map((byte) => Buffer.from([byte])));
    // Then the payloads and order survive exactly.
    expect(answer.map((entry) => entry.type)).toEqual([1, 2, 5]);
    expect(parseControl(answer[0].payload)).toEqual({ op: 'check' });
    expect(answer[1].payload).toEqual(Buffer.from([0, 255, 3]));
  });
  it('accepts a payload at the frame limit', async () => {
    const bytes = Buffer.alloc(MAX_FRAME_BYTES, 42);
    const answer = await decode([frame(FRAME.STDOUT, bytes)]);
    expect(answer[0].payload).toEqual(bytes);
  });
  it.each([[1, MAX_FRAME_BYTES + 1], [6, 0], [5, 1]])('rejects type %i length %i before reading its body', async (type, length) => {
    const header = Buffer.alloc(5); header[0] = type; header.writeUInt32BE(length, 1);
    await expect(decode([header])).rejects.toMatchObject({ code: 'invalid_frame' });
  });
  it.each([Buffer.from([1]), Buffer.from([1, 0, 0, 0, 4, 123])])('rejects a truncated frame', async (bytes) => {
    await expect(decode([bytes])).rejects.toMatchObject({ code: 'truncated_frame' });
  });
  it('rejects invalid UTF-8 instead of replacing bytes inside JSON', () => {
    expect(() => parseControl(Buffer.from([34, 255, 34]))).toThrow(expect.objectContaining({ code: 'invalid_control' }));
  });
});
