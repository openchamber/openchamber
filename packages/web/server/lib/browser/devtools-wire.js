export const DEVTOOLS_CHUNK_BYTES = 32 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_CHUNKS = MAX_COMMAND_BYTES / DEVTOOLS_CHUNK_BYTES;
export const MAX_MESSAGE_CHUNKS = MAX_MESSAGE_BYTES / DEVTOOLS_CHUNK_BYTES;
const MAX_ASSEMBLY_BYTES = 24 * 1024 * 1024;

const identity = (value) => {
  if (value?.constructor !== String || !value || value.length > 128) throw new Error('invalid identity');
  return value;
};

const decodeBase64 = (value) => {
  if (value?.constructor !== String || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical base64');
  return bytes;
};

export const parseDevToolsStart = (message) => ({
  tabId: identity(message.tabId),
  requestId: identity(message.requestId),
  attachmentRequestId: identity(message.attachmentRequestId),
});

export const parseDevToolsStop = (message) => ({
  devtoolsId: message.devtoolsId === undefined ? null : identity(message.devtoolsId),
});

export const parseDevToolsAck = (message) => {
  const direction = message.direction;
  if (direction !== 'command' && direction !== 'message') throw new Error('invalid direction');
  if (!Number.isSafeInteger(message.index) || message.index < 0) throw new Error('invalid index');
  return { devtoolsId: identity(message.devtoolsId), messageId: identity(message.messageId), direction, index: message.index };
};

export const createCommandAssembler = () => {
  const pending = new Map();
  let retainedBytes = 0;

  const accept = (message) => {
    const devtoolsId = identity(message.devtoolsId);
    const messageId = identity(message.messageId);
    if (!Number.isSafeInteger(message.index) || !Number.isSafeInteger(message.count)
      || !Number.isSafeInteger(message.byteLength) || message.index < 0 || message.count < 1
      || message.count > MAX_COMMAND_CHUNKS || message.index >= message.count
      || message.byteLength < 1 || message.byteLength > MAX_COMMAND_BYTES) throw new Error('invalid chunk metadata');
    let entry = pending.get(messageId);
    if (!entry) {
      if (pending.size >= 2) throw new Error('too many assemblies');
      entry = { devtoolsId, count: message.count, byteLength: message.byteLength, chunks: [] };
      pending.set(messageId, entry);
    }
    if (entry.devtoolsId !== devtoolsId || entry.count !== message.count || entry.byteLength !== message.byteLength
      || message.index !== entry.chunks.length) throw new Error('invalid chunk sequence');
    const bytes = decodeBase64(message.data);
    const final = message.index === message.count - 1;
    if (bytes.byteLength > DEVTOOLS_CHUNK_BYTES || (!final && bytes.byteLength !== DEVTOOLS_CHUNK_BYTES)) throw new Error('invalid chunk size');
    retainedBytes += bytes.byteLength;
    if (retainedBytes > MAX_ASSEMBLY_BYTES) throw new Error('assembly limit');
    entry.chunks.push(bytes);
    const ack = final || message.index % 4 === 3 ? message.index : null;
    if (!final) return { devtoolsId, messageId, ack, raw: null };
    pending.delete(messageId);
    retainedBytes -= entry.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const complete = Buffer.concat(entry.chunks);
    if (complete.byteLength !== entry.byteLength) throw new Error('length mismatch');
    return { devtoolsId, messageId, ack, raw: complete.toString('utf8') };
  };

  return { accept, clear() { pending.clear(); retainedBytes = 0; } };
};

export const encodeDevToolsMessage = (raw) => {
  const bytes = Buffer.from(raw, 'utf8');
  if (!bytes.byteLength || bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error('message size');
  const count = Math.ceil(bytes.byteLength / DEVTOOLS_CHUNK_BYTES);
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * DEVTOOLS_CHUNK_BYTES;
    chunks.push({ index, count, byteLength: bytes.byteLength, data: bytes.subarray(start, start + DEVTOOLS_CHUNK_BYTES).toString('base64') });
  }
  return chunks;
};
