const MODE_SET = '\u001b[?2031h';
const MODE_RESET = '\u001b[?2031l';
const CAPABILITY_QUERY = '\u001b[?2031$p';
const MODE_QUERIES = ['\u001b[?996n', '\u001b[?997n'];
const OSC_QUERIES = [10, 11].flatMap((code) => [
  { sequence: `\u001b]${code};?\u0007`, code },
  { sequence: `\u001b]${code};?\u001b\\`, code },
]);
const CONTROL_SEQUENCES = [MODE_SET, MODE_RESET, CAPABILITY_QUERY, ...MODE_QUERIES, ...OSC_QUERIES.map(({ sequence }) => sequence)];

const parseColor = (value) => {
  if (typeof value !== 'string') return null;
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return rgb ? rgb.slice(1, 4).map((part) => Math.min(255, Number(part))) : null;
};

const colorReport = (code, color) => {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const channels = rgb.map((channel) => channel.toString(16).padStart(2, '0').repeat(2));
  return `\u001b]${code};rgb:${channels.join('/')}\u001b\\`;
};

export const terminalThemeModeReport = (themeMode) => `\u001b[?997;${themeMode === 'light' ? 2 : 1}n`;

export const consumeTerminalThemeQueries = (pending, data, appearance) => {
  if (!pending && !data.includes('\u001b')) return { pending: '', responses: [], modeEnabled: appearance.modeEnabled === true };
  const input = `${pending}${data}`;
  const responses = [];
  let modeEnabled = appearance.modeEnabled === true;

  for (let index = 0; index < input.length; index += 1) {
    if (input.startsWith(MODE_SET, index)) {
      modeEnabled = true;
      index += MODE_SET.length - 1;
      continue;
    }
    if (input.startsWith(MODE_RESET, index)) {
      modeEnabled = false;
      index += MODE_RESET.length - 1;
      continue;
    }
    if (input.startsWith(CAPABILITY_QUERY, index)) {
      responses.push(`\u001b[?2031;${modeEnabled ? 1 : 2}$y`);
      index += CAPABILITY_QUERY.length - 1;
      continue;
    }
    const modeQuery = MODE_QUERIES.find((query) => input.startsWith(query, index));
    if (modeQuery) {
      responses.push(terminalThemeModeReport(appearance.themeMode));
      index += modeQuery.length - 1;
      continue;
    }
    const oscQuery = OSC_QUERIES.find(({ sequence }) => input.startsWith(sequence, index));
    if (oscQuery) {
      const response = colorReport(oscQuery.code, oscQuery.code === 10 ? appearance.foreground : appearance.background);
      if (response) responses.push(response);
      index += oscQuery.sequence.length - 1;
    }
  }

  let nextPending = '';
  const maxLength = Math.max(...CONTROL_SEQUENCES.map((sequence) => sequence.length));
  for (let length = 1; length < Math.min(input.length + 1, maxLength); length += 1) {
    const suffix = input.slice(-length);
    if (CONTROL_SEQUENCES.some((sequence) => sequence.length > length && sequence.startsWith(suffix))) nextPending = suffix;
  }
  return { pending: nextPending, responses, modeEnabled };
};
