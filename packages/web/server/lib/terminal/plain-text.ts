const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

const kindOfIntroducer = (code: number) => {
  if (code === 0x5b || code === 0x9b) return 'csi';
  if (code === 0x5d || code === 0x9d) return 'string';
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) return 'string';
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return 'string';
  return null;
};

const endOfString = (input: string, start: number) => {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === BEL || code === ST) return index + 1;
    if (code === ESC && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return input.length;
};

const readCsi = (input: string, start: number) => {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { end: index + 1, final: input[index], params: input.slice(start, index) };
    }
  }
  return { end: input.length, final: null, params: '' };
};

const endOfEscape = (input: string, start: number) => {
  let index = start;
  while (index < input.length && input.charCodeAt(index) >= 0x20 && input.charCodeAt(index) <= 0x2f) index += 1;
  return Math.min(index + 1, input.length);
};

export const terminalPlainText = (input: string) => {
  const lines = [];
  let line: string[] = [];
  let cursor = 0;

  const eraseInLine = (params: string) => {
    const mode = params === '' ? '0' : params;
    if (mode === '0') line.length = Math.min(line.length, cursor);
    else if (mode === '1') line.fill(' ', 0, Math.min(cursor + 1, line.length));
    else if (mode === '2') line = [];
  };

  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === ESC || (code >= 0x80 && code <= 0x9f)) {
      const introducer = code === ESC ? input.charCodeAt(index + 1) : code;
      const bodyStart = index + (code === ESC ? 2 : 1);
      const kind = Number.isNaN(introducer) ? null : kindOfIntroducer(introducer);
      if (kind === 'csi') {
        const csi = readCsi(input, bodyStart);
        if (csi.final === 'K') eraseInLine(csi.params);
        index = csi.end;
      } else if (kind === 'string') {
        index = endOfString(input, bodyStart);
      } else if (code === ESC) {
        index = endOfEscape(input, index + 1);
      } else {
        index += 1;
      }
      continue;
    }

    if (code === 0x0a) {
      lines.push(line.join(''));
      line = [];
      cursor = 0;
    } else if (code === 0x0d) {
      cursor = 0;
    } else if (code === 0x08) {
      cursor = Math.max(0, cursor - 1);
    } else if (code === 0x09 || (code >= 0x20 && code !== 0x7f)) {
      const width = code >= 0xd800 && code <= 0xdbff && index + 1 < input.length ? 2 : 1;
      const char = input.slice(index, index + width);
      while (line.length < cursor) line.push(' ');
      line[cursor] = char;
      cursor += 1;
      index += width;
      continue;
    }
    index += 1;
  }

  return lines.map((text) => `${text}\n`).join('') + line.join('');
};
