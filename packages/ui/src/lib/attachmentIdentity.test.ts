import { describe, expect, test } from 'bun:test';

import { attachmentBasename, attachmentWireName } from './attachmentIdentity';

describe('attachmentWireName', () => {
  test('prefers the on-disk path the model can locate over the basename', () => {
    // A file dropped from the OS reaches OpenCode as `filename` (its `name`),
    // and the model reads that as the file identity. A basename it cannot
    // resolve sends it searching the disk, so the path wins when there is one.
    expect(attachmentWireName({ filename: 'report.xlsx', agentPath: '/Users/me/Documents/report.xlsx' }))
      .toBe('/Users/me/Documents/report.xlsx');
  });

  test('falls back to the basename when no path was resolved', () => {
    // A browser drop, a paste, or a restored attachment: nothing to add, and
    // the basename is all there ever was.
    expect(attachmentWireName({ filename: 'report.xlsx' })).toBe('report.xlsx');
    expect(attachmentWireName({ filename: 'report.xlsx', agentPath: undefined })).toBe('report.xlsx');
  });
});

describe('attachmentBasename', () => {
  test('keeps a plain basename unchanged', () => {
    expect(attachmentBasename('report.xlsx')).toBe('report.xlsx');
  });

  test('reduces a path to its last segment, on either separator', () => {
    // The citation the composer inserts is the basename; the file part the
    // model sees may now carry the path, so matching reduces to the basename.
    expect(attachmentBasename('/Users/me/Documents/report.xlsx')).toBe('report.xlsx');
    expect(attachmentBasename('C:\\Users\\me\\report.xlsx')).toBe('report.xlsx');
    expect(attachmentBasename('src/lib/foo.ts')).toBe('foo.ts');
  });
});
