import { describe, expect, test } from 'bun:test';

import { FilesystemError } from '@/lib/api/files-errors';

import { uploadFailureOf } from './uploadFailure';

describe('uploadFailureOf', () => {
  test('names the file and carries the limit when the server rejects it for its size', () => {
    const error = new FilesystemError('File exceeds maximum size of 104857600 bytes', {
      reason: 'too-large',
      status: 413,
      maxBytes: 104857600,
    });

    expect(uploadFailureOf('clip.mp4', error)).toEqual({
      name: 'clip.mp4',
      reason: 'too-large',
      limitBytes: 104857600,
    });
  });

  test('reports a denied write as a permission failure', () => {
    const error = new FilesystemError('Access denied', { reason: 'os-permission', status: 403 });

    expect(uploadFailureOf('a.txt', error).reason).toBe('permission');
  });

  test('reports a path the workspace refuses as outside the project', () => {
    const error = new FilesystemError('Access denied', { reason: 'outside-workspace', status: 403 });

    expect(uploadFailureOf('a.txt', error).reason).toBe('outside-workspace');
  });

  test('reports a destination folder that is gone', () => {
    const error = new FilesystemError('Destination directory not found', { reason: 'not-found', status: 404 });

    expect(uploadFailureOf('a.txt', error).reason).toBe('folder-missing');
  });

  test('does not guess a cause from a 403 that carries no reason', () => {
    const error = new FilesystemError('Forbidden', { reason: 'unknown', status: 403 });

    expect(uploadFailureOf('a.txt', error).reason).toBe('unknown');
  });

  test('falls back to an unnamed cause for a failed fetch', () => {
    expect(uploadFailureOf('a.txt', null).reason).toBe('unknown');
  });
});
