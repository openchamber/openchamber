import { describe, expect, it } from 'vitest';
import {
  appendTerminalHistory,
  createTerminalHistory,
  sanitizeTerminalHistoryChunk,
  terminalHistoryText,
} from './history.js';

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
});

describe('bounded terminal history', () => {
  it('measures only the new chunk while history is under the cap', () => {
    const measured = [];
    const measure = (value) => {
      measured.push(value);
      return Buffer.byteLength(value);
    };
    const history = createTerminalHistory(32);
    appendTerminalHistory(history, 'hello', measure);
    appendTerminalHistory(history, '!', measure);
    expect(terminalHistoryText(history)).toBe('hello!');
    expect(history.bytes).toBe(6);
    expect(measured).toEqual(['hello', '!']);
  });

  it('trims UTF-8-safe overflow without re-encoding retained history', () => {
    const measured = [];
    const measure = (value) => {
      measured.push(value);
      return Buffer.byteLength(value);
    };
    const history = createTerminalHistory(8);
    appendTerminalHistory(history, 'aaaa', measure);
    appendTerminalHistory(history, 'bbbb', measure);
    measured.length = 0;
    appendTerminalHistory(history, 'éé', measure);
    expect(terminalHistoryText(history)).toBe('bbbbéé');
    expect(history.bytes).toBe(8);
    expect(measured).toEqual(['éé']);
  });

  it('drops a leading multi-byte character instead of slicing it in half', () => {
    const history = createTerminalHistory(4);
    appendTerminalHistory(history, 'ééé');
    expect(history.bytes).toBe(4);
    expect(terminalHistoryText(history)).toBe('éé');
  });
});
