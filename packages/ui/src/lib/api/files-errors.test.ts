import { describe, expect, test } from 'bun:test';

import {
  FilesystemError,
  isFileMissingError,
  isFilesystemError,
  parseFilesystemErrorReason,
} from './files-errors';

describe('FilesystemError', () => {
  test('retains a stable reason and HTTP status', () => {
    const error = new FilesystemError('Access denied', {
      reason: 'os-permission',
      status: 403,
    });

    expect(isFilesystemError(error)).toBe(true);
    expect(error.name).toBe('FilesystemError');
    expect(error.message).toBe('Access denied');
    expect(error.reason).toBe('os-permission');
    expect(error.status).toBe(403);
  });

  test('normalizes unsupported response reasons to unknown', () => {
    expect(parseFilesystemErrorReason('os-permission')).toBe('os-permission');
    expect(parseFilesystemErrorReason('made-up')).toBe('unknown');
    expect(parseFilesystemErrorReason(undefined)).toBe('unknown');
  });

  test('recognizes filesystem errors created across runtime boundaries', () => {
    expect(isFilesystemError({ reason: 'already-exists' })).toBe(true);
    expect(isFilesystemError({ reason: 409 })).toBe(false);
  });
});

describe('isFileMissingError', () => {
  test('recognizes not-found FilesystemError and ENOENT/missing error messages', () => {
    expect(isFileMissingError(new FilesystemError('Missing', { reason: 'not-found' }))).toBe(true);
    expect(isFileMissingError(new Error('ENOENT: no such file or directory, stat \'/repo/test.md\''))).toBe(true);
    expect(isFileMissingError(new Error('File not found'))).toBe(true);
    expect(isFileMissingError(new Error('The specified file does not exist'))).toBe(true);
    expect(isFileMissingError({ message: 'Error: ENOENT' })).toBe(true);
  });

  test('does not misclassify other filesystem or network errors', () => {
    expect(isFileMissingError(new FilesystemError('Forbidden', { reason: 'os-permission' }))).toBe(false);
    expect(isFileMissingError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isFileMissingError(new Error('Request timed out'))).toBe(false);
  });
});
