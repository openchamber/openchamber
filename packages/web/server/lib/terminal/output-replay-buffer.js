export const TERMINAL_OUTPUT_REPLAY_MAX_BYTES = 64 * 1024;

const trimTerminalOutputChunkToMaxBytes = (data, maxBytes) => {
  if (typeof data !== 'string' || data.length === 0) {
    return '';
  }

  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes <= maxBytes) {
    return data;
  }

  const kept = [];
  let trimmedBytes = 0;
  const characters = Array.from(data);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (trimmedBytes + characterBytes > maxBytes) {
      break;
    }
    kept.push(character);
    trimmedBytes += characterBytes;
  }

  return kept.reverse().join('');
};

export const createTerminalOutputReplayBuffer = () => ({
  chunks: [],
  totalBytes: 0,
  nextId: 1,
});

export const appendTerminalOutputReplayChunk = (bufferState, data, maxBytes = TERMINAL_OUTPUT_REPLAY_MAX_BYTES) => {
  if (!bufferState || typeof bufferState !== 'object') {
    return null;
  }

  const normalizedData = trimTerminalOutputChunkToMaxBytes(data, maxBytes);
  if (!normalizedData) {
    return null;
  }

  const bytes = Buffer.byteLength(normalizedData, 'utf8');
  const chunk = {
    id: bufferState.nextId,
    data: normalizedData,
    bytes,
  };

  bufferState.nextId += 1;
  bufferState.chunks.push(chunk);
  bufferState.totalBytes += bytes;

  while (bufferState.totalBytes > maxBytes && bufferState.chunks.length > 1) {
    const removedChunk = bufferState.chunks.shift();
    bufferState.totalBytes -= removedChunk?.bytes ?? 0;
  }

  return chunk;
};

export const listTerminalOutputReplayChunksSince = (bufferState, lastSeenId = 0) => {
  if (!bufferState || typeof bufferState !== 'object' || !Array.isArray(bufferState.chunks)) {
    return [];
  }

  return bufferState.chunks.filter((chunk) => chunk.id > lastSeenId);
};

export const getLatestTerminalOutputReplayChunkId = (bufferState) => {
  if (!bufferState || typeof bufferState !== 'object' || !Array.isArray(bufferState.chunks) || bufferState.chunks.length === 0) {
    return 0;
  }

  return bufferState.chunks[bufferState.chunks.length - 1]?.id ?? 0;
};
