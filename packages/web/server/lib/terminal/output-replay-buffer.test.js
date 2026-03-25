import { describe, expect, it } from 'bun:test';

import {
  TERMINAL_OUTPUT_REPLAY_MAX_BYTES,
  appendTerminalOutputReplayChunk,
  createTerminalOutputReplayBuffer,
  getLatestTerminalOutputReplayChunkId,
  listTerminalOutputReplayChunksSince,
} from './output-replay-buffer.js';

describe('terminal output replay buffer', () => {
  it('starts empty', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    expect(bufferState).toEqual({ chunks: [], totalBytes: 0, nextId: 1 });
    expect(getLatestTerminalOutputReplayChunkId(bufferState)).toBe(0);
  });

  it('appends chunks with incrementing ids', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    const first = appendTerminalOutputReplayChunk(bufferState, 'prompt> ');
    const second = appendTerminalOutputReplayChunk(bufferState, 'ls\r\n');

    expect(first).toEqual({ id: 1, data: 'prompt> ', bytes: 8 });
    expect(second).toEqual({ id: 2, data: 'ls\r\n', bytes: 4 });
    expect(getLatestTerminalOutputReplayChunkId(bufferState)).toBe(2);
  });

  it('lists chunks after a replay cursor', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    appendTerminalOutputReplayChunk(bufferState, 'prompt> ');
    appendTerminalOutputReplayChunk(bufferState, 'ls\r\n');
    appendTerminalOutputReplayChunk(bufferState, 'file.txt\r\n');

    expect(listTerminalOutputReplayChunksSince(bufferState, 1).map((chunk) => chunk.data)).toEqual([
      'ls\r\n',
      'file.txt\r\n',
    ]);
  });

  it('trims old chunks beyond max bytes', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    appendTerminalOutputReplayChunk(bufferState, '1234', 8);
    appendTerminalOutputReplayChunk(bufferState, '5678', 8);
    appendTerminalOutputReplayChunk(bufferState, '90', 8);

    expect(bufferState.chunks.map((chunk) => chunk.data)).toEqual(['5678', '90']);
    expect(bufferState.totalBytes).toBe(6);
  });

  it('trims oversized single chunks to the configured max bytes', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    const chunk = appendTerminalOutputReplayChunk(bufferState, 'abcdefghij', 4);

    expect(chunk?.data).toBe('ghij');
    expect(chunk?.bytes).toBe(4);
    expect(bufferState.totalBytes).toBe(4);
  });

  it('uses the default max bytes when not provided', () => {
    const bufferState = createTerminalOutputReplayBuffer();
    const chunk = appendTerminalOutputReplayChunk(bufferState, 'ok');

    expect(chunk?.bytes).toBe(2);
    expect(TERMINAL_OUTPUT_REPLAY_MAX_BYTES).toBe(64 * 1024);
  });
});
