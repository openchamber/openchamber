import { describe, expect, test } from 'vitest';
import { consumeTerminalThemeQueries } from './theme-response.js';

const lightAppearance = {
  themeMode: 'light',
  foreground: '#1b1b1b',
  background: '#faf8f0',
  modeEnabled: false,
};

describe('terminal theme responses', () => {
  test('answers the complete OpenTUI startup handshake', () => {
    const result = consumeTerminalThemeQueries(
      '',
      '\u001b[?2031h\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?2031$p',
      lightAppearance,
    );
    expect(result).toEqual({
      pending: '',
      modeEnabled: true,
      responses: [
        '\u001b]10;rgb:1b1b/1b1b/1b1b\u001b\\',
        '\u001b]11;rgb:fafa/f8f8/f0f0\u001b\\',
        '\u001b[?2031;1$y',
      ],
    });
  });

  test('handles a query split across PTY output chunks without duplicating it', () => {
    const first = consumeTerminalThemeQueries('', '\u001b]11;', { ...lightAppearance, themeMode: 'dark' });
    const second = consumeTerminalThemeQueries(first.pending, '?\u001b\\', { ...lightAppearance, themeMode: 'dark', modeEnabled: first.modeEnabled });
    const third = consumeTerminalThemeQueries(second.pending, 'x', { ...lightAppearance, themeMode: 'dark', modeEnabled: second.modeEnabled });
    expect(second.responses).toEqual(['\u001b]11;rgb:fafa/f8f8/f0f0\u001b\\']);
    expect(second.pending).toBe('');
    expect(third.responses).toEqual([]);
  });

  test('answers every repeated query in wire order', () => {
    const result = consumeTerminalThemeQueries('', '\u001b[?996n\u001b[?996n\u001b]10;?\u0007\u001b]10;?\u0007', lightAppearance);
    expect(result.responses).toEqual([
      '\u001b[?997;2n',
      '\u001b[?997;2n',
      '\u001b]10;rgb:1b1b/1b1b/1b1b\u001b\\',
      '\u001b]10;rgb:1b1b/1b1b/1b1b\u001b\\',
    ]);
  });
});
