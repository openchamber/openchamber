import { describe, expect, test } from 'bun:test';

import type { FilesAPI } from '@/lib/api/types';
import { validateContextFileOpen } from './contextFileOpenGuard';

const filesApi = (content: string): FilesAPI =>
  ({
    listDirectory: async () => ({ directory: '/', entries: [] }),
    readFile: async () => ({ content, path: '/x' }),
  }) as unknown as FilesAPI;

describe('validateContextFileOpen', () => {
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
