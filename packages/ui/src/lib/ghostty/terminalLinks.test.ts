import { describe, expect, test } from 'bun:test';

import { collectWrappedTerminalLinkLine, extractTerminalLinks } from './terminalLinks';

describe('extractTerminalLinks', () => {
  test('finds http(s) URLs and trims trailing punctuation and unbalanced brackets', () => {
    expect(extractTerminalLinks('see https://example.com/a?b=1). and http://x.y/z,')).toEqual([
      { text: 'https://example.com/a?b=1', start: 4, end: 29 },
      { text: 'http://x.y/z', start: 36, end: 48 },
    ]);
    expect(extractTerminalLinks('(https://example.com/(a))')).toEqual([
      { text: 'https://example.com/(a)', start: 1, end: 24 },
    ]);
  });

  test('ignores bare paths and other schemes', () => {
    expect(extractTerminalLinks('src/lib/x.ts:12 ftp://host/file')).toEqual([]);
  });
});

describe('collectWrappedTerminalLinkLine', () => {
  test('joins wrapped rows and records each segment offset', () => {
    const lines = [
      { isWrapped: false, translateToString: () => 'abc' },
      { isWrapped: true, translateToString: () => 'def' },
      { isWrapped: false, translateToString: () => 'ghi' },
    ];
    expect(collectWrappedTerminalLinkLine(2, (index) => lines[index])).toEqual({
      text: 'abcdef',
      segments: [
        { bufferLineNumber: 1, text: 'abc', startIndex: 0, endIndex: 3 },
        { bufferLineNumber: 2, text: 'def', startIndex: 3, endIndex: 6 },
      ],
    });
  });

  test('returns null when the wrapped head is unavailable', () => {
    const lines = [undefined, { isWrapped: true, translateToString: () => 'x' }];
    expect(collectWrappedTerminalLinkLine(2, (index) => lines[index])).toBeNull();
  });
});
