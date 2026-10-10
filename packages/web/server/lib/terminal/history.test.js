import { describe, expect, it } from 'vitest';
import { sanitizeTerminalHistoryChunk } from './history.js';

describe('terminal replay history', () => {
  it('removes device and color query exchanges while preserving display controls', () => {
    const input = `before\u001b[6n\u001b[12;40R\u001b[>0c\u001b[?2031h\u001b[?2031$p\u001b[?2031;1$y\u001b]10;?\u0007\u001b[31mred\u001b[0mafter`;
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: 'before\u001b[31mred\u001b[0mafter', pending: '' });
  });

  it('carries incomplete control sequences across PTY chunks', () => {
    const first = sanitizeTerminalHistoryChunk('', 'text\u001b]11;');
    expect(first).toEqual({ visible: 'text', pending: '\u001b]11;' });
    expect(sanitizeTerminalHistoryChunk(first.pending, '?\u001b\\next')).toEqual({ visible: 'next', pending: '' });
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
});
