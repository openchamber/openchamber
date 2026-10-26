import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { SCREENSHOT_DIRECTORY, screenshotSlug, writeScreenshot } from './screenshots.js';

const createFs = () => {
  const written = new Map();
  const made = [];
  return {
    written,
    made,
    mkdir: async (target) => { made.push(target); },
    writeFile: async (target, data) => { written.set(target, data); },
  };
};

describe('screenshot labels', () => {
  it('keeps a readable name', () => {
    expect(screenshotSlug('Before fix')).toBe('before-fix');
  });

  it('never lets a label become a path', () => {
    expect(screenshotSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(screenshotSlug('/absolute')).toBe('absolute');
    expect(screenshotSlug('..')).toBe('page');
    expect(screenshotSlug('.hidden')).toBe('hidden');
  });

  it('falls back to a name rather than an empty one', () => {
    expect(screenshotSlug('')).toBe('page');
    expect(screenshotSlug('!!!')).toBe('page');
    expect(screenshotSlug(undefined)).toBe('page');
  });
});

describe('writing a screenshot', () => {
  const base64 = Buffer.from('image-bytes').toString('base64');

  it('writes into the project and reports a portable relative path', async () => {
    const fs = createFs();
    const result = await writeScreenshot({
      directory: '/work/project',
      base64,
      mime: 'image/jpeg',
      label: 'After fix',
      now: new Date('2026-08-13T09:37:00.000Z'),
      fs,
    });

    expect(result.path).toBe('.openchamber/screenshots/after-fix-2026-08-13T09-37-00-000.jpg');
    expect(result.path.includes('\\')).toBe(false);
    expect(result.absolutePath).toBe(path.join('/work/project', SCREENSHOT_DIRECTORY, 'after-fix-2026-08-13T09-37-00-000.jpg'));
    expect(fs.written.get(result.absolutePath).toString()).toBe('image-bytes');
    expect(fs.made[0]).toBe(path.join('/work/project', SCREENSHOT_DIRECTORY));
  });

  it('names the file after the image it actually holds', async () => {
    const fs = createFs();
    const result = await writeScreenshot({ directory: '/work/project', base64, mime: 'image/png', fs });
    expect(result.path.endsWith('.png')).toBe(true);
  });

  it('refuses to write without a project directory', async () => {
    let failed = false;
    try {
      await writeScreenshot({ directory: '', base64, fs: createFs() });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('reports an empty capture instead of writing a zero-byte file', async () => {
    const fs = createFs();
    let failed = false;
    try {
      await writeScreenshot({ directory: '/work/project', base64: '', fs });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(fs.written.size).toBe(0);
  });
});
