import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GENERATED_IMAGE_DIRECTORY, createImageGenerationAction, generatedImagePaths } from './generate-image.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const tempDirs = [];
const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-image-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const tagged = (tag, message = tag) => Object.assign(new Error(message), { _tag: tag });

const setup = ({ settings = { agentImageToolEnabled: true, agentImageModel: 'openrouter/openai/gpt-image-2' }, answer } = {}) => {
  const requests = [];
  const client = {
    experimental: {
      generate: {
        image: async (request, options) => {
          requests.push({ request, options });
          if (answer) return answer(request);
          return { images: Array.from({ length: request.n ?? 1 }, () => ({ type: 'image', data: PNG.toString('base64'), mime: 'image/png' })), cost: 0.04 };
        },
      },
    },
  };
  const generate = createImageGenerationAction({
    getClient: async () => client,
    readSettings: async () => settings,
    fsPromises: fs.promises,
    // Local time: the file is named by the clock the user sees.
    now: () => new Date(2026, 9, 27, 17, 10, 25, 942),
  });
  return { generate, requests };
};

describe('image.generate', () => {
  it('asks OpenCode with the chosen model and saves the image where the agent said', async () => {
    const directory = makeDir();
    const { generate, requests } = setup();

    const result = await generate({ prompt: 'a lighthouse', aspect: '16:9', resolution: '2K', path: 'art/hero' }, { directory });

    expect(requests[0].request).toEqual({ model: { providerID: 'openrouter', id: 'openai/gpt-image-2' }, prompt: 'a lighthouse', aspect: '16:9', resolution: '2K' });
    expect(result).toEqual({ model: 'openrouter/openai/gpt-image-2', images: [{ path: path.join(directory, 'art', 'hero.png'), mime: 'image/png' }], cost: 0.04 });
    expect(fs.readFileSync(path.join(directory, 'art', 'hero.png'))).toEqual(PNG);
  });

  it('numbers the rest of several images, and saves to the temporary folder without a path', async () => {
    const directory = makeDir();
    const { generate } = setup();

    const named = await generate({ prompt: 'icons', count: 3, path: path.join(directory, 'icon.png') }, { directory });
    expect(named.images.map((image) => path.basename(image.path))).toEqual(['icon.png', 'icon-2.png', 'icon-3.png']);

    const unnamed = await generate({ prompt: 'one', count: '1' }, { directory });
    expect(path.dirname(unnamed.images[0].path)).toBe(GENERATED_IMAGE_DIRECTORY);
    expect(path.basename(unnamed.images[0].path)).toBe('image-2026-10-27T17-10-25-942.png');
    fs.rmSync(unnamed.images[0].path, { force: true });
  });

  it('sends reference images and refuses a file that is not an image', async () => {
    const directory = makeDir();
    fs.writeFileSync(path.join(directory, 'ref.png'), PNG);
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'hello');
    const { generate, requests } = setup();

    await generate({ prompt: 'make it blue', images: ['ref.png'], path: 'out.png' }, { directory });
    expect(requests[0].request.images).toEqual([{ data: PNG.toString('base64'), mime: 'image/png', name: 'ref.png' }]);

    await expect(generate({ prompt: 'x', images: ['notes.txt'] }, { directory })).rejects.toMatchObject({ statusCode: 400 });
    await expect(generate({ prompt: 'x', images: ['missing.png'] }, { directory })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Image not found') });
  });

  it('refuses while the tool is off or no model is chosen, before calling OpenCode', async () => {
    const off = setup({ settings: { agentImageToolEnabled: false, agentImageModel: 'a/b' } });
    await expect(off.generate({ prompt: 'x' }, {})).rejects.toMatchObject({ statusCode: 403 });
    const unset = setup({ settings: { agentImageToolEnabled: true } });
    await expect(unset.generate({ prompt: 'x' }, {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Image model') });
    expect([...off.requests, ...unset.requests]).toEqual([]);
  });

  it('refuses a relative path without a session folder before the provider bills an image', async () => {
    const { generate, requests } = setup();
    await expect(generate({ prompt: 'x', path: 'hero.png' }, {})).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('absolute path') });
    expect(requests).toEqual([]);
  });

  it('checks its inputs', async () => {
    const { generate } = setup();
    await expect(generate({}, {})).rejects.toMatchObject({ statusCode: 400, message: 'prompt is required' });
    await expect(generate({ prompt: 'x', count: 9 }, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(generate({ prompt: 'x', aspect: 'wide' }, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(generate({ prompt: 'x', images: Array(9).fill('a.png') }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('tells the agent what OpenCode refused', async () => {
    const failing = (error) => setup({ answer: () => { throw error; } }).generate({ prompt: 'x', path: '/tmp/never.png' }, {});
    await expect(failing(tagged('UnsupportedModelError'))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('cannot generate images') });
    await expect(failing(tagged('ModelNotFoundError'))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no longer available') });
    await expect(failing(tagged('ProviderRequestError', 'insufficient credits'))).rejects.toMatchObject({ statusCode: 502, message: 'The provider refused: insufficient credits' });
    await expect(setup({ answer: () => ({ images: [] }) }).generate({ prompt: 'x' }, {})).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('generatedImagePaths', () => {
  it('reads the saved paths from a successful result envelope only', () => {
    const envelope = (ok, data) => JSON.stringify({ schemaVersion: 1, ok, action: 'image.generate', data });
    expect(generatedImagePaths(envelope(true, { images: [{ path: '/tmp/a.png' }, { path: '' }] }))).toEqual(['/tmp/a.png']);
    expect(generatedImagePaths(envelope(false, { images: [{ path: '/tmp/a.png' }] }))).toEqual([]);
    expect(generatedImagePaths('not json')).toEqual([]);
  });
});
