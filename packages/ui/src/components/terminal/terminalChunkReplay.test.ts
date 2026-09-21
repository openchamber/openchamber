import { describe, expect, test } from 'bun:test';

import type { TerminalChunk } from '@/stores/useTerminalStore';

import { selectTerminalChunkReplay } from './terminalChunkReplay';

const chunk = (id: number, data = `${id}`): TerminalChunk => ({
  id,
  data,
  byteLength: data.length,
});

describe('selectTerminalChunkReplay', () => {
  const firstMountChunks = [chunk(1, 'one'), chunk(2, 'two')];
  const incrementalChunks = [chunk(4, 'four'), chunk(5, 'five'), chunk(6, 'six')];
  const replacementChunks = [chunk(8, 'eight'), chunk(9, 'nine')];

  const cases: Array<{
    name: string;
    chunks: TerminalChunk[];
    lastChunkId: number | null;
    expected: { reset: boolean; replay: boolean; pending: TerminalChunk[] };
  }> = [
    {
      name: 'first mount replays the full current buffer without resetting the renderer',
      chunks: firstMountChunks,
      lastChunkId: null,
      expected: { reset: false, replay: true, pending: firstMountChunks },
    },
    {
      name: 'known tail appends only newer chunks incrementally',
      chunks: incrementalChunks,
      lastChunkId: 5,
      expected: { reset: false, replay: false, pending: [incrementalChunks[2]!] },
    },
    {
      name: 'missing prior id replaces the whole current buffer',
      chunks: replacementChunks,
      lastChunkId: 7,
      expected: { reset: true, replay: true, pending: replacementChunks },
    },
    {
      name: 'a prior id newer than the current tail replaces the whole current buffer',
      chunks: replacementChunks,
      lastChunkId: 10,
      expected: { reset: true, replay: true, pending: replacementChunks },
    },
    {
      name: 'an empty current buffer resets only when prior content existed',
      chunks: [],
      lastChunkId: 12,
      expected: { reset: true, replay: false, pending: [] },
    },
    {
      name: 'an empty current buffer without prior content is a no-op',
      chunks: [],
      lastChunkId: null,
      expected: { reset: false, replay: false, pending: [] },
    },
  ];

  for (const { name, chunks, lastChunkId, expected } of cases) {
    test(name, () => {
      expect(selectTerminalChunkReplay(chunks, lastChunkId)).toEqual(expected);
    });
  }
});
