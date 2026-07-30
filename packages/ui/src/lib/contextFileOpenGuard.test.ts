import { describe, expect, test } from 'bun:test';
import type { FilesAPI } from '@/lib/api/types';
import { validateContextFileOpen } from './contextFileOpenGuard';

describe('validateContextFileOpen', () => {
  test('does not read Office documents as text', async () => {
    let readCount = 0;
    const files = {
      readFile: async () => {
        readCount += 1;
        return { content: '', path: '/workspace/slides.pptx' };
      },
    } as unknown as FilesAPI;

    expect(await validateContextFileOpen(files, '/workspace/slides.pptx')).toEqual({ ok: true });
    expect(readCount).toBe(0);
  });
});
