const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stripDiffSnapshotEntry = (entry) => {
  if (!isRecord(entry)) {
    return entry;
  }

  const looksLikeDiffEntry = (
    typeof entry.file === 'string'
    || typeof entry.status === 'string'
    || Object.prototype.hasOwnProperty.call(entry, 'additions')
    || Object.prototype.hasOwnProperty.call(entry, 'deletions')
  );

  const hasBefore = Object.prototype.hasOwnProperty.call(entry, 'before');
  const hasAfter = Object.prototype.hasOwnProperty.call(entry, 'after');

  if (!looksLikeDiffEntry || (!hasBefore && !hasAfter)) {
    return entry;
  }

  const nextEntry = { ...entry };
  delete nextEntry.before;
  delete nextEntry.after;
  return nextEntry;
};

export const sanitizeMessagePayload = (value) => {
  if (Array.isArray(value)) {
    let changed = false;
    const nextItems = value.map((item) => {
      const nextItem = sanitizeMessagePayload(item);
      if (nextItem !== item) {
        changed = true;
      }
      return nextItem;
    });

    return changed ? nextItems : value;
  }

  if (!isRecord(value)) {
    return value;
  }

  const maybeSnapshotEntry = stripDiffSnapshotEntry(value);
  if (maybeSnapshotEntry !== value) {
    return maybeSnapshotEntry;
  }

  let changed = false;
  let nextValue = value;

  for (const [key, child] of Object.entries(value)) {
    const nextChild = sanitizeMessagePayload(child);
    if (nextChild === child) {
      continue;
    }

    if (!changed) {
      nextValue = { ...value };
      changed = true;
    }

    nextValue[key] = nextChild;
  }

  return changed ? nextValue : value;
};

export const rewriteJsonSseBlock = (block, transform) => {
  if (typeof block !== 'string' || block.length === 0 || typeof transform !== 'function') {
    return { block, parsedPayload: null, changed: false };
  }

  const lines = block.split('\n');
  const preservedLines = [];
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
      continue;
    }

    preservedLines.push(line);
  }

  if (dataLines.length === 0) {
    return { block, parsedPayload: null, changed: false };
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return { block, parsedPayload: null, changed: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return { block, parsedPayload: null, changed: false };
  }

  const transformed = transform(parsed);
  const parsedPayload = isRecord(transformed) && isRecord(transformed.payload)
    ? transformed.payload
    : transformed;

  if (transformed === parsed) {
    return { block, parsedPayload, changed: false };
  }

  return {
    block: [...preservedLines, `data: ${JSON.stringify(transformed)}`].join('\n'),
    parsedPayload,
    changed: true,
  };
};
