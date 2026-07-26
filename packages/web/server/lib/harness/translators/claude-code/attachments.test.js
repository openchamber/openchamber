import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  assertPathInsideCwd,
  isSupportedAttachmentMime,
  mapAttachmentToContentBlock,
  mapAttachmentsToContentBlocks,
  toFileUrl,
} from './attachments.js';

describe('claude-code attachments', () => {
  it('maps image/png data URL to an SDK image block', () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const mapped = mapAttachmentToContentBlock({
      mime: 'image/png',
      filename: 'shot.png',
      url: `data:image/png;base64,${pngBase64}`,
    });

    expect(mapped.block).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: pngBase64,
      },
    });
    expect(isSupportedAttachmentMime('image/png')).toBe(true);
  });

  it('rejects application/zip with a clear error', () => {
    const zipBase64 = Buffer.from('PK').toString('base64');
    expect(() => mapAttachmentToContentBlock({
      mime: 'application/zip',
      filename: 'archive.zip',
      url: `data:application/zip;base64,${zipBase64}`,
    })).toThrow(/not supported/);

    try {
      mapAttachmentToContentBlock({
        mime: 'application/zip',
        filename: 'archive.zip',
        url: `data:application/zip;base64,${zipBase64}`,
      });
    } catch (error) {
      expect(error.code).toBe('ATTACHMENT_UNSUPPORTED_TYPE');
      expect(error.statusCode).toBe(400);
    }
  });

  it('maps multiple attachments and rejects oversize turns', () => {
    const text = Buffer.from('hello').toString('base64');
    const blocks = mapAttachmentsToContentBlocks([
      {
        mime: 'text/plain',
        filename: 'note.txt',
        url: `data:text/plain;base64,${text}`,
      },
    ]);
    expect(blocks[0].type).toBe('text');
    expect(String(blocks[0].text)).toContain('note.txt');
  });

  it('maps sandboxed file:// project paths to path references', () => {
    const cwd = '/project';
    const absolute = path.join(cwd, 'src', 'main.ts');
    const files = new Map([
      [absolute, Buffer.from('export const x = 1\n')],
    ]);
    const stats = new Map([
      [absolute, { isFile: () => true, size: 18 }],
    ]);

    const blocks = mapAttachmentsToContentBlocks([
      {
        mime: 'text/plain',
        filename: 'main.ts',
        url: toFileUrl(absolute),
      },
    ], {
      cwd,
      readFileSync: (filePath) => {
        const value = files.get(filePath);
        if (!value) throw new Error('ENOENT');
        return value;
      },
      statSync: (filePath) => {
        const value = stats.get(filePath);
        if (!value) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return value;
      },
    });

    expect(blocks).toEqual([
      { type: 'text', text: 'Attached project file: src/main.ts' },
    ]);
  });

  it('embeds file:// images when path references are disabled', () => {
    const cwd = '/project';
    const absolute = path.join(cwd, 'shot.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const blocks = mapAttachmentsToContentBlocks([
      {
        mime: 'image/png',
        filename: 'shot.png',
        url: toFileUrl(absolute),
      },
    ], {
      cwd,
      preferPathReferences: false,
      readFileSync: () => bytes,
      statSync: () => ({ isFile: () => true, size: bytes.length }),
    });

    expect(blocks[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: bytes.toString('base64'),
      },
    });
  });

  it('rejects file:// paths outside the project cwd', () => {
    expect(() => assertPathInsideCwd('/etc/passwd', '/project')).toThrow(/outside/);
    expect(() => mapAttachmentToContentBlock({
      mime: 'text/plain',
      filename: 'passwd',
      url: toFileUrl('/etc/passwd'),
    }, { cwd: '/project' })).toThrow(/outside/);
  });

  it('rejects unsupported file:// binaries even as path references', () => {
    const cwd = '/project';
    const absolute = path.join(cwd, 'archive.zip');
    expect(() => mapAttachmentsToContentBlocks([
      {
        mime: 'application/zip',
        filename: 'archive.zip',
        url: toFileUrl(absolute),
      },
    ], {
      cwd,
      readFileSync: () => Buffer.from('PK'),
      statSync: () => ({ isFile: () => true, size: 2 }),
    })).toThrow(/not supported/);
  });
});
