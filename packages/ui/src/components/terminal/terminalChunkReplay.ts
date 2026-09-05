import type { TerminalChunk } from '@/stores/useTerminalStore';

export interface TerminalChunkReplaySelection {
  reset: boolean;
  replay: boolean;
  pending: TerminalChunk[];
}

export function selectTerminalChunkReplay(
  chunks: TerminalChunk[],
  lastChunkId: number | null,
): TerminalChunkReplaySelection {
  if (chunks.length === 0) {
    return {
      reset: lastChunkId !== null,
      replay: false,
      pending: [],
    };
  }

  if (lastChunkId === null) {
    return {
      reset: false,
      replay: true,
      pending: chunks,
    };
  }

  let previousIndex = -1;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const id = chunks[index].id;
    if (id === lastChunkId) {
      previousIndex = index;
      break;
    }
    if (id < lastChunkId) break;
  }

  if (previousIndex < 0) {
    return {
      reset: true,
      replay: true,
      pending: chunks,
    };
  }

  return {
    reset: false,
    replay: false,
    pending: chunks.slice(previousIndex + 1),
  };
}
