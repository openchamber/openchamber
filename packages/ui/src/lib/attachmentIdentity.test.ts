import { describe, expect, test } from 'bun:test';

import { attachmentBasename, attachmentWireName } from './attachmentIdentity';

describe('attachmentWireName', () => {
  test('prefers the on-disk path the model can locate over the basename', () => {
    expect(attachmentWireName({ filename: 'report.xlsx', agentPath: '/Users/me/Documents/report.xlsx' }))
      .toBe('/Users/me/Documents/report.xlsx');
  });

  test('falls back to the basename when no path was resolved', () => {
    expect(attachmentWireName({ filename: 'report.xlsx' })).toBe('report.xlsx');
    expect(attachmentWireName({ filename: 'report.xlsx', agentPath: undefined })).toBe('report.xlsx');
  });
});

describe('attachmentBasename', () => {
  test('keeps a plain basename unchanged', () => {
    expect(attachmentBasename('report.xlsx')).toBe('report.xlsx');
  });

  test('reduces a path to its last segment, on either separator', () => {
    expect(attachmentBasename('/Users/me/Documents/report.xlsx')).toBe('report.xlsx');
    expect(attachmentBasename('C:\\Users\\me\\report.xlsx')).toBe('report.xlsx');
    expect(attachmentBasename('src/lib/foo.ts')).toBe('foo.ts');
    expect(attachmentBasename('\\\\server\\share\\report.xlsx')).toBe('report.xlsx');
    expect(attachmentBasename('weird\\name.txt')).toBe('weird\\name.txt');
    expect(attachmentBasename('/home/me/weird\\name.txt')).toBe('weird\\name.txt');
  });
});
