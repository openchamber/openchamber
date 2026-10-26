import { describe, expect, it, vi } from 'vitest';
import { sanitizeTerminalHistoryChunk } from './history.js';

describe('terminal replay history', () => {
  it('removes device and color query exchanges while preserving display controls', () => {
    const input = `before\u001b[6n\u001b[12;40R\u001b[>0c\u001b[?2031h\u001b[?2031$p\u001b[?2031;1$y\u001b]10;?\u0007\u001b[31mred\u001b[0mafter`;
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: 'before\u001b[31mred\u001b[0mafter', pending: '' });
  });

  it('preserves display controls and strips queries at every PTY chunk boundary', () => {
    const cases = [
      ['\u001b(0', '\u001b(0'],
      ['\u001b#8', '\u001b#8'],
      ['\u001bD', '\u001bD'],
    ];
    for (const prefix of ['\u001b[', '\u009b']) {
      for (const body of ['6n', '12;40R', '>0c', '?2031h', '?2031l', '?2031$p', '?2031;1$y']) cases.push([prefix + body, '']);
      for (const body of ['31m', '0m', '?25h']) cases.push([prefix + body, prefix + body]);
    }
    for (const prefix of ['\u001b]', '\u009d', '\u001bP', '\u0090', '\u001b^', '\u009e', '\u001b_', '\u009f']) {
      for (const terminator of ['\u0007', '\u009c', '\u001b\\']) {
        const sequence = `${prefix}0;title\uD83D\uDE00${terminator}`;
        cases.push([sequence, sequence]);
        if (prefix === '\u001b]' || prefix === '\u009d') {
          cases.push([`${prefix}11;?${terminator}`, '']);
          cases.push([`${prefix}12;rgb:ffff/0000/aaaa${terminator}`, '']);
        }
      }
    }
    for (const [sequence, expected] of cases) {
      for (let split = 0; split <= sequence.length; split += 1) {
        let pending = '';
        let visible = '';
        for (const chunk of [`before${sequence.slice(0, split)}`, '', `${sequence.slice(split)}after`]) {
          const result = sanitizeTerminalHistoryChunk(pending, chunk);
          visible += result.visible;
          pending = result.pending;
        }
        expect(visible).toBe(`before${expected}after`);
        expect(pending).toBe('');
      }
    }
  });

  it('preserves ordinary OSC titles and split UTF-16 text', () => {
    expect(sanitizeTerminalHistoryChunk('', '\u001b]0;title\u0007ok')).toEqual({ visible: '\u001b]0;title\u0007ok', pending: '' });
  });

  it('passes a clean chunk of ordinary text through unchanged', () => {
    const line = 'build result source/file.ts 0123456789\r\n';
    expect(sanitizeTerminalHistoryChunk('', line)).toEqual({ visible: line, pending: '' });
  });

  it('keeps ordinary runs between display controls in one piece', () => {
    const input = 'line1\r\n\u001b[1mbold\u001b[0m\r\nline2 tail';
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: input, pending: '' });
  });

  it('strips C1 device queries and keeps C1 string controls', () => {
    expect(sanitizeTerminalHistoryChunk('', 'a\u009b6nb')).toEqual({ visible: 'ab', pending: '' });
    expect(sanitizeTerminalHistoryChunk('', 'x\u009d10;?\u009cy\u009d0;title\u009cz')).toEqual({
      visible: 'xy\u009d0;title\u009cz',
      pending: '',
    });
  });

  it('keeps DCS and APC string controls in the replay text', () => {
    const input = 'a\u00901;2|data\u009cb\u001b[_apc\u0007c';
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: input, pending: '' });
  });

  it('bounds unfinished control strings and discards their payload through a split terminator', () => {
    let pending = sanitizeTerminalHistoryChunk('', '\u001b]0;').pending;
    const chunk = 'payload'.repeat(585) + 'x';
    for (let index = 0; index < 1024; index += 1) {
      const result = sanitizeTerminalHistoryChunk(pending, chunk);
      expect(result.visible).toBe('');
      expect(JSON.stringify(result.pending).length).toBeLessThan(16 * 1024);
      pending = result.pending;
    }
    const tail = sanitizeTerminalHistoryChunk(pending, 'hidden\u001b');
    expect(tail.visible).toBe('');
    expect(sanitizeTerminalHistoryChunk(tail.pending, '\\visible')).toEqual({ visible: 'visible', pending: '' });
  });

  it('recovers from oversized C1 and ESC controls only at their terminators', () => {
    const cases = [
      ...['\u001b]', '\u009d', '\u001bP', '\u0090', '\u001b^', '\u009e', '\u001b_', '\u009f'].flatMap(prefix =>
        ['\u0007', '\u009c', '\u001b\\'].map(terminator => [prefix, 'payload', terminator])),
      ['\u001b[', '1;', 'm'],
      ['\u009b', '1;', 'm'],
      ['\u001b', ' ', 'B'],
    ];
    for (const [prefix, payload, terminator] of cases) {
      let pending = sanitizeTerminalHistoryChunk('', `before${prefix}`).pending;
      for (let index = 0; index < 8; index += 1) {
        const result = sanitizeTerminalHistoryChunk(pending, payload.repeat(2048));
        expect(result.visible).toBe('');
        pending = result.pending;
      }
      const first = sanitizeTerminalHistoryChunk(pending, terminator.slice(0, -1));
      expect(first.visible).toBe('');
      expect(sanitizeTerminalHistoryChunk(first.pending, `${terminator.slice(-1)}after\u001b[6n`)).toEqual({ visible: 'after', pending: '' });
    }
  });

  it('applies the same sequence limit to complete, split, and one-character chunks', () => {
    for (const length of [8191, 8192, 8193]) {
      const sequence = `\u001b]0;${'x'.repeat(length - 6)}\u001b\\`;
      for (const chunkSize of [sequence.length, 4096, 1]) {
        let pending = '';
        let visible = '';
        for (let start = 0; start < sequence.length; start += chunkSize) {
          const result = sanitizeTerminalHistoryChunk(pending, sequence.slice(start, start + chunkSize));
          visible += result.visible;
          pending = result.pending;
        }
        expect(visible).toBe(length <= 8192 ? sequence : '');
        expect(pending).toBe('');
      }
    }
  });

  it('keeps scan work linear for one-character PTY callbacks', () => {
    const scans = vi.spyOn(String.prototype, 'charCodeAt');
    let pending = '';
    try {
      pending = sanitizeTerminalHistoryChunk(pending, '\u001b]0;').pending;
      for (let index = 0; index < 1024; index += 1) pending = sanitizeTerminalHistoryChunk(pending, 'x').pending;
      expect(scans.mock.calls.length).toBeLessThan(4096);
    } finally { scans.mockRestore(); }
    expect(sanitizeTerminalHistoryChunk(pending, '\u0007').visible).toBe(`\u001b]0;${'x'.repeat(1024)}\u0007`);
  });
});
