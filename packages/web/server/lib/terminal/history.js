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
const findStringEnd = (input, start) => {
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
  return input.charCodeAt(cursor) >= 0x30 && input.charCodeAt(cursor) <= 0x7e ? cursor + 1 : start + 1;
};

export const sanitizeTerminalHistoryChunk = (pending, data) => {
  const input = `${pending}${data}`;
  let visible = '';
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (Number.isNaN(next)) return { visible, pending: input.slice(index) };
      if (next === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
        if (cursor >= input.length) return { visible, pending: input.slice(index) };
        const sequence = input.slice(index, cursor + 1);
        if (!shouldStripCsi(input.slice(index + 2, cursor), input[cursor])) visible += sequence;
        index = cursor + 1;
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        const end = findStringEnd(input, index + 2);
        if (end === null) return { visible, pending: input.slice(index) };
        const sequence = input.slice(index, end);
        const content = stripTerminator(input.slice(index + 2, end));
        if (next !== 0x5d || !shouldStripOsc(content)) visible += sequence;
        index = end;
        continue;
      }
      const end = findEscapeEnd(input, index + 1);
      if (end === null) return { visible, pending: input.slice(index) };
      visible += input.slice(index, end);
      index = end;
      continue;
    }
    if (code === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
      if (cursor >= input.length) return { visible, pending: input.slice(index) };
      const sequence = input.slice(index, cursor + 1);
      if (!shouldStripCsi(input.slice(index + 1, cursor), input[cursor])) visible += sequence;
      index = cursor + 1;
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
      const end = findStringEnd(input, index + 1);
      if (end === null) return { visible, pending: input.slice(index) };
      const sequence = input.slice(index, end);
      const content = stripTerminator(input.slice(index + 1, end));
      if (code !== 0x9d || !shouldStripOsc(content)) visible += sequence;
      index = end;
      continue;
    }
    visible += input[index];
    index += 1;
  }
  return { visible, pending: '' };
};
