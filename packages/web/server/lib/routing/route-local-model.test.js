import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { LOCAL_MODEL, downloadModel } from './route-local-model.js';

const CONTENT = Buffer.from('a stand-in for the model file');
const sha256Of = (content) => crypto.createHash('sha256').update(content).digest('hex');
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-')), LOCAL_MODEL.file);
const modelFor = (overrides = {}) => ({
  ...LOCAL_MODEL,
  url: 'https://models.test/stand-in.gguf',
  bytes: CONTENT.length,
  sha256: sha256Of(CONTENT),
  ...overrides,
});
const serve = (content) => vi.fn(async () => new Response(content, { status: 200 }));

describe('local model pin', () => {
  it('pins the shipped model to one Hugging Face commit and a full SHA-256', () => {
    expect(LOCAL_MODEL.url).toContain('/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/');
    expect(LOCAL_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('downloadModel', () => {
  it('refuses a model with no pinned checksum before fetching, and writes nothing', async () => {
    const file = tempFile();
    const fetchImpl = serve(CONTENT);
    await expect(downloadModel({ file, model: modelFor({ sha256: null }), fetchImpl })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/No checksum is pinned/),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('keeps a download whose size and SHA-256 both match', async () => {
    const file = tempFile();
    const status = await downloadModel({ file, model: modelFor(), fetchImpl: serve(CONTENT) });
    expect(status).toMatchObject({ installed: true, downloadedBytes: CONTENT.length });
    expect(fs.readFileSync(file)).toEqual(CONTENT);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('discards a download whose SHA-256 differs and leaves no model file behind', async () => {
    const file = tempFile();
    const model = modelFor({ sha256: sha256Of('some other model') });
    await expect(downloadModel({ file, model, fetchImpl: serve(CONTENT) })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/did not match its checksum/),
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('discards an incomplete download before the digest is compared', async () => {
    const file = tempFile();
    const model = modelFor({ bytes: CONTENT.length + 1 });
    await expect(downloadModel({ file, model, fetchImpl: serve(CONTENT) })).rejects.toMatchObject({
      message: expect.stringMatching(/incomplete/),
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('aborts a download larger than the pinned size without consuming the whole body', async () => {
    const file = tempFile();
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 50) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.from('y'.repeat(CONTENT.length)));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(downloadModel({ file, model: modelFor(), fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/larger than the expected/),
    });
    expect(pulls).toBeLessThan(50);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('cancels the response body when it refuses an oversized download', async () => {
    const file = tempFile();
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(Buffer.from('y'.repeat(CONTENT.length)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(downloadModel({ file, model: modelFor(), fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/larger than the expected/),
    });
    expect(cancelled).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('times out a download whose response never arrives and leaves nothing behind', async () => {
    const file = tempFile();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const startedAt = Date.now();
    await expect(downloadModel({ file, model: modelFor(), fetchImpl, stallTimeoutMs: 100 })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/timed out .* without receiving data/),
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('times out a download whose body goes silent mid-stream and discards the partial file', async () => {
    const file = tempFile();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(CONTENT.subarray(0, 4));
      },
      pull() {
        return new Promise(() => {});
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(downloadModel({ file, model: modelFor(), fetchImpl, stallTimeoutMs: 100 })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/timed out .* without receiving data/),
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it.each(['drain', 'end'])('times out a stalled write %s and discards the partial file', async (phase) => {
    const file = tempFile();
    const fetchImpl = serve(CONTENT);
    let out;
    const createWriteStreamImpl = (partial) => {
      fs.writeFileSync(partial, CONTENT.subarray(0, 1));
      out = new Writable({
        highWaterMark: phase === 'drain' ? 1 : 1024,
        write(_chunk, _encoding, callback) {
          if (phase !== 'drain') callback();
        },
        final(_callback) {},
      });
      return out;
    };
    await expect(downloadModel({ file, model: modelFor(), fetchImpl, createWriteStreamImpl, stallTimeoutMs: 100 })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/timed out .* without receiving data/),
    });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(out.destroyed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('lets a slow download finish while bytes keep arriving inside the stall bound', async () => {
    const file = tempFile();
    const chunks = [];
    for (let offset = 0; offset < CONTENT.length; offset += 5) chunks.push(CONTENT.subarray(offset, offset + 5));
    let index = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]);
        index += 1;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    // Six chunks at 40 ms gaps: total time passes the 150 ms stall bound,
    // but no gap does, so the download must complete.
    const status = await downloadModel({ file, model: modelFor(), fetchImpl, stallTimeoutMs: 150 });
    expect(status).toMatchObject({ installed: true });
    expect(fs.readFileSync(file)).toEqual(CONTENT);
  });

  it('keeps an installed file of the pinned size without downloading it again', async () => {
    const file = tempFile();
    fs.writeFileSync(file, CONTENT);
    const fetchImpl = serve(CONTENT);
    expect(await downloadModel({ file, model: modelFor(), fetchImpl })).toMatchObject({ installed: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
