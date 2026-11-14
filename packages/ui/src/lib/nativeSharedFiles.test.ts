import { describe, expect, test } from 'bun:test';

import { parseSharedFiles } from './nativeSharedFiles';

// Not a real document: this path's contract is that the bytes arrive unchanged, whatever
// media type the extension announced them as.
const FILE_BYTES = new Uint8Array([1, 2, 3, 250, 251, 255]);
const FILE_BASE64 = Buffer.from(FILE_BYTES).toString('base64');

describe('shared files payload', () => {
  test('decodes a staged file with its name and declared type', async () => {
    const payload = parseSharedFiles({
      files: [{ name: 'report.pdf', mimeType: 'application/pdf', data: FILE_BASE64 }],
    });

    expect(payload?.rejected).toEqual([]);
    expect(payload?.text).toBeNull();
    expect(payload?.files).toHaveLength(1);
    const [file] = payload!.files;
    expect(file.name).toBe('report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(FILE_BYTES);
  });

  test('passes the names the extension refused to the caller', () => {
    const payload = parseSharedFiles({
      files: [],
      rejected: [{ name: 'huge.zip', reason: 'too-large' }],
    });

    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([{ name: 'huge.zip', reason: 'too-large' }]);
  });

  test('reports a file whose base64 cannot be decoded instead of dropping it', () => {
    const payload = parseSharedFiles({
      files: [{ name: 'broken.bin', mimeType: 'application/octet-stream', data: '!!!!' }],
    });

    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([{ name: 'broken.bin', reason: 'unreadable' }]);
  });

  test('rejects a shape the plugin never promised', () => {
    expect(parseSharedFiles({ files: [{ name: 'note.txt' }] })).toBeNull();
    expect(parseSharedFiles({ text: 42 })).toBeNull();
    expect(parseSharedFiles(undefined)).toBeNull();
  });

  test('keeps a shared link or paragraph as text with no files', () => {
    const payload = parseSharedFiles({ text: '  https://openchamber.dev/session/abc\n' });

    expect(payload?.text).toBe('https://openchamber.dev/session/abc');
    expect(payload?.files).toEqual([]);
    expect(payload?.rejected).toEqual([]);
  });

  test('carries both when the share had text and a file', () => {
    const payload = parseSharedFiles({
      text: 'Screenshot from the failing run',
      files: [{ name: 'shot.png', mimeType: 'image/png', data: FILE_BASE64 }],
    });

    expect(payload?.text).toBe('Screenshot from the failing run');
    expect(payload?.files).toHaveLength(1);
  });

  test('treats blank text as no text', () => {
    const payload = parseSharedFiles({ text: '   \n ', files: [] });

    expect(payload?.text).toBeNull();
  });
});
