const MAX_CONTROL_SEQUENCE_CHARS = 8 * 1024;
const isCsiFinalByte = (code) => code >= 0x40 && code <= 0x7e;
const shouldStripCsi = (body, finalByte) =>
  finalByte === 'n'
  || (finalByte === 'R' && /^[0-9;?]*$/.test(body))
  || (finalByte === 'c' && /^[>0-9;?]*$/.test(body))
  || ((finalByte === 'p' || finalByte === 'y') && /^\?2031(?:;[0-9]+)?\$$/.test(body))
  || ((finalByte === 'h' || finalByte === 'l') && body === '?2031');
const shouldStripOsc = (content) => /^(10|11|12);(?:\?|rgb:)/.test(content);
const stripTerminator = (value) => {
  if (value.endsWith('\u001b\\')) return value.slice(0, -2);
  return value.endsWith('\u0007') || value.endsWith('\u009c') ? value.slice(0, -1) : value;
};
const findStringEnd = (input, start, escaped) => {
  if (escaped && input.charCodeAt(start) === 0x5c) return start + 1;
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
};
const findEscapeEnd = (input, start) => {
  let cursor = start;
  while (cursor < input.length && input.charCodeAt(cursor) >= 0x20 && input.charCodeAt(cursor) <= 0x2f) cursor += 1;
  if (cursor >= input.length) return null;
  return input.charCodeAt(cursor) >= 0x30 && input.charCodeAt(cursor) <= 0x7e ? cursor + 1 : cursor;
};
const controlKind = (code) => {
  if (code === 0x5b || code === 0x9b) return 'csi';
  if (code === 0x5d || code === 0x9d) return 'osc';
  if (code === 0x50 || code === 0x5e || code === 0x5f || code === 0x90 || code === 0x9e || code === 0x9f) return 'string';
  return 'escape';
};
const findControlEnd = (kind, input, start, escaped = false) => {
  if (kind === 'osc' || kind === 'string') return findStringEnd(input, start, escaped);
  if (kind === 'escape') return findEscapeEnd(input, start);
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isCsiFinalByte(input.charCodeAt(cursor))) return cursor + 1;
  }
  return null;
};
const shouldKeepControl = (kind, sequence, prefixLength) => {
  if (kind === 'csi') return !shouldStripCsi(sequence.slice(prefixLength, -1), sequence.at(-1));
  return kind !== 'osc' || !shouldStripOsc(stripTerminator(sequence.slice(prefixLength)));
};
const appendControlText = (pending, input, start, end) => {
  if (!pending.chunks || start === end) return;
  const length = end - start;
  if (pending.length + length > MAX_CONTROL_SEQUENCE_CHARS) {
    pending.chunks = null;
    pending.length = 0;
    return;
  }
  // Copy retained UTF-16 fragments so a short suffix cannot pin a large PTY
  // callback. UTF-16 also preserves surrogate pairs split across callbacks.
  pending.chunks.push(Buffer.from(input.slice(start, end), 'utf16le').toString('utf16le'));
  pending.length += length;
};
const carryControl = (kind, prefixLength, input, start) => {
  const pending = { kind, prefixLength, chunks: [], length: 0, escaped: input.endsWith('\u001b') };
  appendControlText(pending, input, start, input.length);
  return pending;
};

// All six control-string introducers: ESC, DCS, CSI, OSC, PM, and APC. Replay
// history has to notice every one, or a C1 query byte leaks into the replay.
const isControlIntroducer = (code) => code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
const findControlIntroducer = (input, start) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isControlIntroducer(input.charCodeAt(cursor))) return cursor;
  }
  return -1;
};

export const sanitizeTerminalHistoryChunk = (pending, data) => {
  // Ordinary text needs no replay projection or carried state.
  if (!pending && findControlIntroducer(data, 0) === -1) return { visible: data, pending: '' };
  if (!data) return { visible: '', pending };
  let input = data;
  let visible = '';
  let index = 0;
  if (pending) {
    if (pending.kind === 'introducer') {
      input = `\u001b${data}`;
    } else {
      const end = findControlEnd(pending.kind, data, 0, pending.escaped);
      appendControlText(pending, data, 0, end ?? data.length);
      if (end === null) {
        pending.escaped = data.endsWith('\u001b');
        return { visible, pending };
      }
      if (pending.chunks) {
        const sequence = pending.chunks.join('');
        if (shouldKeepControl(pending.kind, sequence, pending.prefixLength)) visible = sequence;
      }
      index = end;
    }
    pending = '';
  }
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (isControlIntroducer(code)) {
      const next = code === 0x1b ? input.charCodeAt(index + 1) : code;
      if (Number.isNaN(next)) return { visible, pending: carryControl('introducer', 1, input, index) };
      const kind = controlKind(next);
      const prefixLength = code === 0x1b && kind !== 'escape' ? 2 : 1;
      const end = findControlEnd(kind, input, index + prefixLength);
      if (end === null) return { visible, pending: carryControl(kind, prefixLength, input, index) };
      if (end - index <= MAX_CONTROL_SEQUENCE_CHARS) {
        const sequence = input.slice(index, end);
        if (shouldKeepControl(kind, sequence, prefixLength)) visible += sequence;
      }
      index = end;
      continue;
    }
    // Ordinary text: copy the whole run up to the next introducer in one
    // slice instead of appending one character at a time.
    const runEnd = findControlIntroducer(input, index + 1);
    if (runEnd === -1) {
      visible += input.slice(index);
      break;
    }
    visible += input.slice(index, runEnd);
    index = runEnd;
  }
  return { visible, pending: '' };
};
