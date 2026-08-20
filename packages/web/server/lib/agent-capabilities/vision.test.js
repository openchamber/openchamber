import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../small-model/call.js', () => ({
  callSmallModel: vi.fn(),
}));
vi.mock('../small-model/catalog.js', () => ({
  getModelCatalog: vi.fn(async () => ({})),
}));
vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
}));

const { createVisionRuntime } = await import('./vision.js');
const { callSmallModel } = await import('../small-model/call.js');
const { DEFAULT_VISION_PROMPT } = await import('../opencode/settings-helpers.js');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const createRuntime = (overrides = {}) => {
  const fetchMock = vi.fn();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const runtime = createVisionRuntime({
    readSettingsFromDiskMigrated: vi.fn(async () => ({ vision: { model: 'anthropic/claude-sonnet-4' } })),
    buildOpenCodeUrl: (urlPath) => `http://127.0.0.1:4099${urlPath}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
    statFile: vi.fn(async () => ({ isFile: () => true, size: PNG_BYTES.length })),
    readFile: vi.fn(async () => PNG_BYTES),
    realpathFile: vi.fn(async (filePath) => filePath),
    ...overrides,
  });
  return { runtime, fetchMock, restore: () => { globalThis.fetch = previousFetch; } };
};

const imageCapableProviders = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    providers: [
      {
        id: 'anthropic',
        models: [
          { id: 'claude-sonnet-4', capabilities: { input: { image: true } } },
          { id: 'claude-haiku-4', capabilities: { input: { image: false } } },
        ],
      },
    ],
  }),
});

describe('createVisionRuntime', () => {
  beforeEach(() => {
    callSmallModel.mockReset();
  });

  it('describes an image through the configured vision model', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('A dashboard with two charts.');

      const result = await runtime.execute({ imagePath: '/work/shot.png', directory: '/work' });

      expect(result).toEqual({
        description: 'A dashboard with two charts.',
        truncated: false,
        model: 'anthropic/claude-sonnet-4',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        imagePath: '/work/shot.png',
        imageFilename: 'shot.png',
        imageMime: 'image/png',
        imageSize: PNG_BYTES.length,
      });
      expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
        workingDirectory: '/work',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        prompt: DEFAULT_VISION_PROMPT,
        images: [{ mimeType: 'image/png', base64: PNG_BYTES.toString('base64') }],
        maxOutputTokens: 2_000,
      }));
    } finally {
      restore();
    }
  });

  it('uses the configured prompt and appends the optional question', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        vision: { model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' },
      })),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('brief');

      await runtime.execute({ imagePath: '/work/shot.png', directory: '/work', question: 'What error is shown?' });

      expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Describe briefly.\n\nAnswer this additional question about the image:\nWhat error is shown?',
      }));
    } finally {
      restore();
    }
  });

  it('resolves relative paths against the directory context', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('ok');

      const result = await runtime.execute({ imagePath: 'assets/shot.png', directory: '/work/repo' });

      expect(result.imagePath).toBe(path.resolve('/work/repo', 'assets/shot.png'));
    } finally {
      restore();
    }
  });

  it('expands ~ and strips file:// URLs', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('ok');

      const home = os.homedir();
      const tildeResult = await runtime.execute({ imagePath: '~/pics/shot.png', directory: home });
      expect(tildeResult.imagePath).toBe(path.join(home, 'pics/shot.png'));

      const urlResult = await runtime.execute({ imagePath: 'file:///work/shot.png', directory: '/work' });
      expect(urlResult.imagePath).toBe('/work/shot.png');
    } finally {
      restore();
    }
  });

  it('fails fast when no vision model is configured', async () => {
    const { runtime, restore } = createRuntime({
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    });
    try {
      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('No vision model configured') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects a configured model that no longer exists', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ vision: { model: 'anthropic/claude-opus-99' } })),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());

      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('was not found') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects a configured model without image input capability', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ vision: { model: 'anthropic/claude-haiku-4' } })),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());

      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('does not support image input') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('fails open when the provider snapshot is unavailable', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
      callSmallModel.mockResolvedValue('ok');

      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' })).resolves.toMatchObject({
        description: 'ok',
      });
    } finally {
      restore();
    }
  });

  it('requires an imagePath', async () => {
    const { runtime, restore } = createRuntime();
    try {
      await expect(runtime.execute({ directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: 'imagePath is required' });
    } finally {
      restore();
    }
  });

  it('requires a directory context so the image stays inside the workspace', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/shot.png' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('directory context') });
    } finally {
      restore();
    }
  });

  it('rejects an absolute path outside the session workspace', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/etc/passwd', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('inside the session directory') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects a traversal that escapes the session workspace', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '../secret.png', directory: '/work/repo' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('inside the session directory') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects a symlink inside the workspace pointing outside it', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      realpathFile: vi.fn(async () => '/etc/private.png'),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/link.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('inside the session directory') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('accepts a symlink inside the workspace that resolves inside it', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      realpathFile: vi.fn(async () => '/work/shared/shot.png'),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('ok');
      const result = await runtime.execute({ imagePath: '/work/link.png', directory: '/work' });
      expect(result.description).toBe('ok');
    } finally {
      restore();
    }
  });

  it('reports a missing image file as a usage error', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      statFile: vi.fn(async () => {
        const error = new Error('ENOENT: no such file');
        error.code = 'ENOENT';
        throw error;
      }),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/missing.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Image file not found') });
    } finally {
      restore();
    }
  });

  it('rejects directories and oversize images', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      statFile: vi.fn(async () => ({ isFile: () => false, size: 10 })),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/folder', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not a file') });
    } finally {
      restore();
    }

    const { runtime: oversized, fetchMock: fetchOversized, restore: restoreOversized } = createRuntime({
      statFile: vi.fn(async () => ({ isFile: () => true, size: 21 * 1024 * 1024 })),
    });
    try {
      fetchOversized.mockResolvedValue(imageCapableProviders());
      await expect(oversized.execute({ imagePath: '/work/big.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('larger than 20 MB') });
    } finally {
      restoreOversized();
    }
  });

  it('rejects a file that grows past the cap between stat and read', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      statFile: vi.fn(async () => ({ isFile: () => true, size: PNG_BYTES.length })),
      readFile: vi.fn(async () => Buffer.alloc(21 * 1024 * 1024, 1)),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('larger than 20 MB') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects non-image content by magic bytes', async () => {
    const { runtime, fetchMock, restore } = createRuntime({
      readFile: vi.fn(async () => Buffer.from('just some text, not an image')),
    });
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      await expect(runtime.execute({ imagePath: '/work/notes.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Unsupported image type') });
      expect(callSmallModel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('truncates oversized descriptions at 60k characters', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockResolvedValue('x'.repeat(61_000));

      const result = await runtime.execute({ imagePath: '/work/shot.png', directory: '/work' });

      expect(result.truncated).toBe(true);
      expect(result.description.length).toBeLessThan(61_000);
      expect(result.description).toContain('… (truncated)');
    } finally {
      restore();
    }
  });

  it('surfaces cancellation as a 499 control error', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      const controller = new AbortController();
      callSmallModel.mockImplementation(async ({ signal }) => {
        await new Promise((_, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      });
      controller.abort();
      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work', signal: controller.signal }))
        .rejects.toMatchObject({ statusCode: 499, message: 'OpenChamber action was cancelled' });
    } finally {
      restore();
    }
  });

  it('passes provider errors through untouched when not aborted', async () => {
    const { runtime, fetchMock, restore } = createRuntime();
    try {
      fetchMock.mockResolvedValue(imageCapableProviders());
      callSmallModel.mockRejectedValue(Object.assign(new Error('No OpenCode login found for provider "anthropic"'), { statusCode: 401 }));

      await expect(runtime.execute({ imagePath: '/work/shot.png', directory: '/work' }))
        .rejects.toMatchObject({ statusCode: 401 });
    } finally {
      restore();
    }
  });
});
