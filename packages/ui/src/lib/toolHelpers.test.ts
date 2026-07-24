import { describe, expect, test } from 'bun:test';

import { isOfficeDocumentFile } from './toolHelpers';

describe('isOfficeDocumentFile', () => {
  const officeDocuments = [
    'report.doc',
    'report.docx',
    'workbook.xls',
    'workbook.xlsx',
    'slides.ppt',
    'slides.pptx',
    'document.odt',
    'workbook.ods',
    'slides.odp',
  ];

  for (const filePath of officeDocuments) {
    test(`recognizes packaged and legacy office document ${filePath}`, () => {
      expect(isOfficeDocumentFile(filePath)).toBe(true);
    });
  }

  test('matches extensions case-insensitively', () => {
    expect(isOfficeDocumentFile('/workspace/Quarterly Review.PPTX')).toBe(true);
  });

  const otherFiles = [
    'notes.txt',
    'slides.md',
    'archive.zip',
    'report.pdf',
    'presentation.pptx.txt',
  ];

  for (const filePath of otherFiles) {
    test(`does not classify non-office file ${filePath}`, () => {
      expect(isOfficeDocumentFile(filePath)).toBe(false);
    });
  }
});
