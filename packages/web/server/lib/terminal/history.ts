type ControlKind = 'csi' | 'osc' | 'string' | 'escape';

interface PendingControl {
  kind: ControlKind | 'introducer';
  prefixLength: number;
  chunks: string[] | null;
  length: number;
  escaped: boolean;
}

export type TerminalHistoryPending = '' | PendingControl;

export interface TerminalHistoryChunk {
  visible: string;
  pending: TerminalHistoryPending;
}

const MAX_CONTROL_SEQUENCE_CHARS = 8 * 1024;
const isCsiFinalByte = (code: number) => code >= 0x40 && code <= 0x7e;
const shouldStripCsi = (body: string, finalByte: string | undefined) =>
  finalByte === 'n'
  || (finalByte === 'R' && /^[0-9;?]*$/.test(body))
  || (finalByte === 'c' && /^[>0-9;?]*$/.test(body))
  || ((finalByte === 'p' || finalByte === 'y') && /^\?2031(?:;[0-9]+)?\$$/.test(body))
  || ((finalByte === 'h' || finalByte === 'l') && body === '?2031');
const shouldStripOsc = (content: string) => /^(10|11|12);(?:\?|rgb:)/.test(content);
const stripTerminator = (value: string) => {
  if (value.endsWith('\u001b\\')) return value.slice(0, -2);
  return value.endsWith('\u0007') || value.endsWith('\u009c') ? value.slice(0, -1) : value;
};
const findStringEnd = (input: string, start: number, escaped: boolean) => {
  if (escaped && input.charCodeAt(start) === 0x5c) return start + 1;
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
};
const findEscapeEnd = (input: string, start: number) => {
  let cursor = start;
  while (cursor < input.length && input.charCodeAt(cursor) >= 0x20 && input.charCodeAt(cursor) <= 0x2f) cursor += 1;
  if (cursor >= input.length) return null;
  return input.charCodeAt(cursor) >= 0x30 && input.charCodeAt(cursor) <= 0x7e ? cursor + 1 : cursor;
};
const controlKind = (code: number): ControlKind => {
  if (code === 0x5b || code === 0x9b) return 'csi';
  if (code === 0x5d || code === 0x9d) return 'osc';
  if (code === 0x50 || code === 0x5e || code === 0x5f || code === 0x90 || code === 0x9e || code === 0x9f) return 'string';
  return 'escape';
};
const findControlEnd = (kind: ControlKind, input: string, start: number, escaped = false) => {
  if (kind === 'osc' || kind === 'string') return findStringEnd(input, start, escaped);
  if (kind === 'escape') return findEscapeEnd(input, start);
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isCsiFinalByte(input.charCodeAt(cursor))) return cursor + 1;
  }
  return null;
};
const shouldKeepControl = (kind: ControlKind, sequence: string, prefixLength: number) => {
  if (kind === 'csi') return !shouldStripCsi(sequence.slice(prefixLength, -1), sequence.at(-1));
  return kind !== 'osc' || !shouldStripOsc(stripTerminator(sequence.slice(prefixLength)));
};
const appendControlText = (pending: PendingControl, input: string, start: number, end: number) => {
  if (!pending.chunks || start === end) return;
  const length = end - start;
  if (pending.length + length > MAX_CONTROL_SEQUENCE_CHARS) {
    pending.chunks = null;
    pending.length = 0;
    return;
  }
  pending.chunks.push(Buffer.from(input.slice(start, end), 'utf16le').toString('utf16le'));
  pending.length += length;
};
const carryControl = (kind: PendingControl['kind'], prefixLength: number, input: string, start: number) => {
  const pending: PendingControl = { kind, prefixLength, chunks: [], length: 0, escaped: input.endsWith('\u001b') };
  appendControlText(pending, input, start, input.length);
  return pending;
};

const isControlIntroducer = (code: number) => code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
const findControlIntroducer = (input: string, start: number) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isControlIntroducer(input.charCodeAt(cursor))) return cursor;
  }
  return -1;
};

export const sanitizeTerminalHistoryChunk = (pending: TerminalHistoryPending, data: string): TerminalHistoryChunk => {
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
