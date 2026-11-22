import { describe, expect, test } from 'bun:test';

import { assignFileAttachmentFilenames, attachmentBasename, attachmentWireName, attachmentsCitedIn, withMissingCitations } from './attachmentIdentity';

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

describe('the attachments a send includes', () => {
  const files = [{ filename: 'shot.png' }, { filename: 'notes.txt' }, { filename: 'saved.png' }];

  test('only the cited ones, as a chip or as a saved-image link, by name in any case', () => {
    expect(attachmentsCitedIn('see [SHOT.png] and [saved.png](/tmp/saved.png)', files).map((file) => file.filename))
      .toEqual(['shot.png', 'saved.png']);
  });

  test('a deleted chip leaves its file out', () => {
    expect(attachmentsCitedIn('nothing cited', files)).toEqual([]);
  });
});

describe('putting a draft back with its attachments', () => {
  test('appends a chip for each file the text does not cite yet', () => {
    expect(withMissingCitations('look [shot.png]  ', [{ filename: 'shot.png' }, { filename: 'notes.txt' }]))
      .toBe('look [shot.png] [notes.txt]');
  });

  test('an empty text gets the chips alone, a fully cited one stays as it is', () => {
    expect(withMissingCitations('', [{ filename: 'a.png' }])).toBe('[a.png]');
    expect(withMissingCitations('[a.png]', [{ filename: 'a.png' }])).toBe('[a.png]');
  });
});

describe('names for attached files', () => {
  test('a free name stays, a taken one gets the next number before the extension', () => {
    expect(assignFileAttachmentFilenames([{ name: 'report.pdf' }, { name: 'report.pdf' }, { name: 'Makefile' }], ['REPORT.pdf', 'Makefile']))
      .toEqual(['report-2.pdf', 'report-3.pdf', 'Makefile-2']);
  });

  test('square brackets become parentheses so the chip holds the whole name', () => {
    expect(assignFileAttachmentFilenames([{ name: 'notes [draft].md' }], [])).toEqual(['notes (draft).md']);
  });
});

describe('a cited document', () => {
  test('takes the images extracted from it, which have no chip of their own', () => {
    const files = [
      { filename: 'design.docx', sourceDocumentId: 'd1' },
      { filename: 'design-image-1.png', sourceDocumentId: 'd1' },
      { filename: 'other-image.png', sourceDocumentId: 'd2' },
    ];
    expect(attachmentsCitedIn('see [design.docx]', files).map((file) => file.filename)).toEqual(['design.docx', 'design-image-1.png']);
  });
});
