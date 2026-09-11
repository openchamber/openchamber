import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listInstalledGuests } from './catalog.js';
import { buildStoreZip } from './extract-zip.test.js';
import { installGuestFromZipBuffer } from './install.js';
import { guestCopiesDir } from './persist.js';
import { guestUploadMaxBytes, readGuestUploadBody } from './upload.js';

const fakeRequest = ({ headers = {}, chunks = [] } = {}) => {
  let resumed = false;
  return {
    headers: { 'content-type': 'application/octet-stream', ...headers },
    resume: () => {
      resumed = true;
    },
    wasResumed: () => resumed,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
};

const guestZip = (id) => buildStoreZip([
  { name: 'package.json', data: JSON.stringify({
    name: `@openchamber/${id}`,
    version: '1.0.0',
    openchamber: {
      apiVersion: 1,
      contributes: {
        panel: { id, name: 'Uploaded', icon: 'window', entry: 'panel/index.html' },
      },
    },
  }) },
  { name: 'panel/index.html', data: '<html></html>' },
]);

describe('readGuestUploadBody', () => {
  test('collects an octet-stream body under the cap', async () => {
    const req = fakeRequest({ chunks: [Buffer.from('ab'), Buffer.from('cd')] });
    const body = await readGuestUploadBody(req, 10);
    expect(body).toEqual({ ok: true, buffer: Buffer.from('abcd') });
  });

  test('refuses a wrong content type without reading the body', async () => {
    const req = fakeRequest({ headers: { 'content-type': 'multipart/form-data' }, chunks: [Buffer.from('abcd')] });
    const body = await readGuestUploadBody(req, 10);
    expect(body).toEqual({ ok: false, status: 415, error: 'unsupported-media-type' });
    expect(req.wasResumed()).toBe(true);
  });

  test('refuses a declared size over the cap before reading', async () => {
    const req = fakeRequest({ headers: { 'content-length': '11' }, chunks: [Buffer.from('abcd')] });
    const body = await readGuestUploadBody(req, 10);
    expect(body).toEqual({ ok: false, status: 413, error: 'too-large' });
    expect(req.wasResumed()).toBe(true);
  });

  test('stops a body that grows past the cap without a declared size', async () => {
    const req = fakeRequest({ chunks: [Buffer.from('12345'), Buffer.from('678901')] });
    const body = await readGuestUploadBody(req, 10);
    expect(body).toEqual({ ok: false, status: 413, error: 'too-large' });
  });

  test('reads the cap from the environment', () => {
    const previous = process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES;
    try {
      delete process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES;
      expect(guestUploadMaxBytes()).toBe(50 * 1024 * 1024);
      process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES = '1234';
      expect(guestUploadMaxBytes()).toBe(1234);
      process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES = 'nope';
      expect(guestUploadMaxBytes()).toBe(50 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES;
      else process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES = previous;
    }
  });
});

describe('installGuestFromZipBuffer', () => {
  test('installs from bytes, lists with source zip, and reinstalls only with replace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-upload-'));
    const persistPath = path.join(dir, 'extensions.json');
    const buffer = guestZip('upload-hello');

    const installed = await installGuestFromZipBuffer(buffer, persistPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      throw new Error('expected upload install');
    }
    expect(installed.guest.id).toBe('upload-hello');
    expect(installed.guest.source).toBe('zip');
    expect(installed.replaced).toBe(false);
    const copy = path.join(guestCopiesDir(persistPath), 'upload-hello');
    expect(await fs.stat(path.join(copy, 'package.json')).then((stat) => stat.isFile())).toBe(true);

    const listed = await listInstalledGuests({ persistPath });
    expect(listed.map((guest) => [guest.id, guest.source])).toEqual([['upload-hello', 'zip']]);

    const again = await installGuestFromZipBuffer(buffer, persistPath);
    expect(again).toEqual({ ok: false, code: 'already-installed', id: 'upload-hello' });

    const replaced = await installGuestFromZipBuffer(buffer, persistPath, { replace: true });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      throw new Error('expected replace');
    }
    expect(replaced.replaced).toBe(true);
    expect((await listInstalledGuests({ persistPath })).length).toBe(1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('answers extract-failed for bytes that are not a zip and leaves nothing behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-upload-'));
    const persistPath = path.join(dir, 'extensions.json');

    const result = await installGuestFromZipBuffer(Buffer.from('this is a text file, not a zip'), persistPath);
    expect(result).toEqual({ ok: false, code: 'extract-failed' });
    expect(await listInstalledGuests({ persistPath })).toEqual([]);
    const leftovers = await fs.readdir(guestCopiesDir(persistPath)).catch(() => []);
    expect(leftovers).toEqual([]);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
