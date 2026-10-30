import { describe, expect, spyOn, test } from 'bun:test';

import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { MAX_OPEN_FILE_BYTES, MAX_OPEN_FILE_LINES } from '@/lib/fileOpenLimits';
import { formatFileSize } from '@/lib/fileSize';
import { dict } from '@/lib/i18n/messages/en';
import { formatMessage } from '@/lib/i18n/store';
import { getContextFileSizeLimitMessage, toastContextFileOpenFailure, validateContextFileOpen } from './contextFileOpenGuard';

const filesApi = (content: string): FilesAPI =>
  ({
    listDirectory: async () => ({ directory: '/', entries: [] }),
    readFile: async () => ({ content, path: '/x' }),
  }) as unknown as FilesAPI;

describe('validateContextFileOpen', () => {
  test('renders both limit toasts with the file name, actual size and no placeholders', () => {
    const error = spyOn(toast, 'error').mockImplementation(() => 'test-toast');
    const sizeBytes = 14 * 1024 * 1024;
    try {
      toastContextFileOpenFailure('/repo/big.txt', { reason: 'too-large-size', sizeBytes });
      expect(error.mock.calls.at(-1)).toEqual(['big.txt is too large to open', {
        description: `Larger than ${formatFileSize(MAX_OPEN_FILE_BYTES)} · ${formatFileSize(sizeBytes)}`,
      }]);
      toastContextFileOpenFailure('C:\\repo\\big.log', { reason: 'too-large', sizeBytes });
      expect(error.mock.calls.at(-1)).toEqual(['big.log is too large to open', {
        description: `More than ${MAX_OPEN_FILE_LINES.toLocaleString('en-US')} lines · ${formatFileSize(sizeBytes)}`,
      }]);
      for (const [title, options] of error.mock.calls) {
        expect(/\{[^}]*\}/.test(`${title} ${options?.description}`)).toBe(false);
      }
    } finally {
      error.mockRestore();
    }
  });

  test('formats the Files pane size refusal with the limit and actual size', () => {
    const message = getContextFileSizeLimitMessage(14 * 1024 * 1024, (key, params) => formatMessage(dict, key, params));
    expect(message).toBe('Larger than 10.0 MB · 14.0 MB');
    expect(/\{[^}]*\}/.test(message)).toBe(false);
  });

  test('allows known binaries through without reading text', async () => {
    const files = {
      listDirectory: async () => ({ directory: '/', entries: [] }),
      readFile: async () => {
        throw new Error('should not read binary as text');
      },
    } as unknown as FilesAPI;

    expect(await validateContextFileOpen(files, '/repo/docs/report.pdf')).toEqual({ ok: true });
    expect(await validateContextFileOpen(files, '/repo/docs/report.docx')).toEqual({ ok: true });
    expect(await validateContextFileOpen(files, '/repo/docs/pixel.png')).toEqual({ ok: true });
    expect(await validateContextFileOpen(files, '/repo/bin/archive.zip')).toEqual({ ok: true });
  });

  test('rejects text payloads that look binary', async () => {
    expect(await validateContextFileOpen(filesApi('%PDF-1.7\nbinary'), '/repo/mystery.bin.bak')).toEqual({
      ok: false,
      reason: 'binary',
    });
  });

  test('refuses a file past the size limit without reading it', async () => {
    let reads = 0;
    const files: FilesAPI = {
      listDirectory: async () => ({ directory: '/', entries: [] }),
      search: async () => [],
      createDirectory: async () => ({ success: true, path: '/' }),
      statFile: async (path) => ({ path, isFile: true, size: MAX_OPEN_FILE_BYTES + 1 }),
      readFile: async (path) => {
        reads += 1;
        return { content: 'hello\n', path };
      },
    };

    expect(await validateContextFileOpen(files, '/repo/place.rbxl', { directory: '/repo' })).toEqual({
      ok: false,
      reason: 'too-large-size',
      sizeBytes: MAX_OPEN_FILE_BYTES + 1,
    });
    expect(reads).toBe(0);
  });

  test('reads a file within the size limit', async () => {
    const files: FilesAPI = {
      listDirectory: async () => ({ directory: '/', entries: [] }),
      search: async () => [],
      createDirectory: async () => ({ success: true, path: '/' }),
      statFile: async (path) => ({ path, isFile: true, size: MAX_OPEN_FILE_BYTES }),
      readFile: async (path) => ({ content: 'hello\n', path }),
    };

    expect(await validateContextFileOpen(files, '/repo/notes.txt', { directory: '/repo' })).toEqual({ ok: true });
  });

  test('reports a file over the line limit with its size', async () => {
    const content = 'x\n'.repeat(20_001);
    expect(await validateContextFileOpen(filesApi(content), '/repo/app.log')).toEqual({
      ok: false,
      reason: 'too-large',
      sizeBytes: content.length,
    });
  });

  test('keeps the server reason of a failed read, not the generic fallback', async () => {
    const failing = (message: string): FilesAPI => ({
      listDirectory: async () => ({ directory: '/', entries: [] }),
      search: async () => [],
      createDirectory: async () => ({ success: true, path: '/' }),
      readFile: async () => {
        throw new Error(message);
      },
    });

    expect(await validateContextFileOpen(failing("EACCES: permission denied, open '/repo/secret.env'"), '/repo/secret.env')).toEqual({
      ok: false,
      reason: 'unreadable',
      message: "EACCES: permission denied, open '/repo/secret.env'",
    });
    expect(await validateContextFileOpen(failing('Failed to read file'), '/repo/secret.env')).toEqual({
      ok: false,
      reason: 'unreadable',
      message: null,
    });
    expect(await validateContextFileOpen(failing('ENOENT: no such file'), '/repo/gone.txt')).toEqual({ ok: false, reason: 'missing' });
  });

  test('allows ordinary text files', async () => {
    expect(await validateContextFileOpen(filesApi('hello\nworld\n'), '/repo/notes.txt')).toEqual({ ok: true });
  });

  test('reads outside-workspace paths with allowOutsideWorkspace', async () => {
    const reads: Array<{ path: string; allowOutsideWorkspace: boolean | undefined }> = [];
    const files: FilesAPI = {
      listDirectory: async () => ({ directory: '/', entries: [] }),
      search: async () => [],
      createDirectory: async () => ({ success: true, path: '/' }),
      readFile: async (path, options) => {
        reads.push({ path, allowOutsideWorkspace: options?.allowOutsideWorkspace });
        return { content: 'hello\n', path };
      },
    };

    expect(await validateContextFileOpen(files, '/tmp/notes.txt', { directory: '/repo' })).toEqual({ ok: true });
    expect(reads).toEqual([{ path: '/tmp/notes.txt', allowOutsideWorkspace: true }]);
  });

  test('does not set allowOutsideWorkspace for in-workspace paths', async () => {
    const reads: Array<{ allowOutsideWorkspace: boolean | undefined }> = [];
    const files: FilesAPI = {
      listDirectory: async () => ({ directory: '/', entries: [] }),
      search: async () => [],
      createDirectory: async () => ({ success: true, path: '/' }),
      readFile: async (path, options) => {
        reads.push({ allowOutsideWorkspace: options?.allowOutsideWorkspace });
        return { content: 'hello\n', path };
      },
    };

    expect(await validateContextFileOpen(files, '/repo/notes.txt', { directory: '/repo' })).toEqual({ ok: true });
    expect(reads[0]?.allowOutsideWorkspace).toBe(false);
  });
});
