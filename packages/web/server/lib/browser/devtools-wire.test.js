import { describe, expect, it } from 'vitest';

import {
  createCommandAssembler, DEVTOOLS_CHUNK_BYTES, encodeDevToolsMessage,
  MAX_COMMAND_BYTES, MAX_COMMAND_CHUNKS, MAX_MESSAGE_BYTES, MAX_MESSAGE_CHUNKS,
} from './devtools-wire.js';

const encode = (bytes) => Buffer.from(bytes).toString('base64');

describe('DevTools bounded wire format', () => {
  it('round-trips multi-chunk UTF-8 commands in strict order', () => {
    const raw = `${'x'.repeat(DEVTOOLS_CHUNK_BYTES)}é`;
    const bytes = Buffer.from(raw, 'utf8');
    const assembler = createCommandAssembler();
    expect(assembler.accept({
      devtoolsId: 'devtools-a', messageId: 'command-a', index: 0, count: 2,
      byteLength: bytes.byteLength, data: encode(bytes.subarray(0, DEVTOOLS_CHUNK_BYTES)),
    })).toMatchObject({ ack: null, raw: null });
    expect(assembler.accept({
      devtoolsId: 'devtools-a', messageId: 'command-a', index: 1, count: 2,
      byteLength: bytes.byteLength, data: encode(bytes.subarray(DEVTOOLS_CHUNK_BYTES)),
    })).toMatchObject({ ack: 1, raw });
  });

  it('enforces fixed byte and chunk ceilings with at most two partial commands', () => {
    expect(MAX_COMMAND_CHUNKS).toBe(MAX_COMMAND_BYTES / DEVTOOLS_CHUNK_BYTES);
    expect(MAX_MESSAGE_CHUNKS).toBe(MAX_MESSAGE_BYTES / DEVTOOLS_CHUNK_BYTES);
    const assembler = createCommandAssembler();
    const partial = (messageId) => assembler.accept({
      devtoolsId: 'devtools-a', messageId, index: 0, count: 2,
      byteLength: DEVTOOLS_CHUNK_BYTES + 1, data: encode(Buffer.alloc(DEVTOOLS_CHUNK_BYTES)),
    });
    partial('command-a');
    partial('command-b');
    expect(() => partial('command-c')).toThrow('too many assemblies');
    expect(() => createCommandAssembler().accept({
      devtoolsId: 'devtools-a', messageId: 'command-a', index: 0, count: MAX_COMMAND_CHUNKS + 1,
      byteLength: 1, data: 'eA==',
    })).toThrow('invalid chunk metadata');
  });

  it('encodes complete protocol messages without truncating chunk metadata', () => {
    const raw = 'é'.repeat(20_000);
    const chunks = encodeDevToolsMessage(raw);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((entry) => entry.count === 2 && entry.byteLength === Buffer.byteLength(raw))).toBe(true);
    expect(Buffer.concat(chunks.map((entry) => Buffer.from(entry.data, 'base64'))).toString('utf8')).toBe(raw);
  });
});
