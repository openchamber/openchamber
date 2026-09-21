import { describe, expect, test } from 'bun:test';

import {
  getFileExtension,
  isBinaryFile,
  isImageFile,
  isPdfFile,
  isSvgFile,
  looksLikeBinaryText,
} from './toolHelpers';

describe('binary file helpers', () => {
  test('classifies common binary extensions', () => {
    expect(isBinaryFile('/repo/docs/report.pdf')).toBe(true);
    expect(isBinaryFile('/repo/sheet.XLSX')).toBe(true);
    expect(isBinaryFile('archive.zip')).toBe(true);
    expect(isBinaryFile('photo.png')).toBe(true);
    expect(isBinaryFile('notes.docx')).toBe(true);
    expect(isPdfFile('report.pdf')).toBe(true);
    expect(isImageFile('photo.png')).toBe(true);
  });

  test('keeps text and SVG editable', () => {
    expect(isBinaryFile('/repo/README.md')).toBe(false);
    expect(isBinaryFile('/repo/src/main.ts')).toBe(false);
    expect(isBinaryFile('/repo/icon.svg')).toBe(false);
    expect(isSvgFile('/repo/icon.svg')).toBe(true);
    expect(isBinaryFile('/repo/.env')).toBe(false);
  });

  test('getFileExtension ignores leading dots and path separators', () => {
    expect(getFileExtension('/a/b/c.PDF')).toBe('pdf');
    expect(getFileExtension('.gitignore')).toBe('');
    expect(getFileExtension('Makefile')).toBe('');
  });

  test('looksLikeBinaryText detects nulls, PDF, ZIP, and replacement-heavy content', () => {
    expect(looksLikeBinaryText('hello\0world')).toBe(true);
    expect(looksLikeBinaryText('%PDF-1.7\nstream\n...')).toBe(true);
    expect(looksLikeBinaryText(`PK\u0003\u0004${'x'.repeat(20)}`)).toBe(true);
    expect(looksLikeBinaryText(`${'\uFFFD'.repeat(40)}${'a'.repeat(40)}`)).toBe(true);
    expect(looksLikeBinaryText('plain text file\nwith newlines\n')).toBe(false);
  });
});
