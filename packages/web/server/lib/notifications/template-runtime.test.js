import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses zen models with zero-cost metadata as selectable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            opencode: {
              models: {
                'big-pickle': { cost: { input: 0, output: 0 } },
                'gpt-5-nano': { cost: { input: 0, output: 0 } },
                'gpt-5.5': { cost: { input: 5, output: 30 } },
                'hy3-preview-free': { cost: { input: 0, output: 0 } },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'big-pickle', owned_by: 'opencode' },
            { id: 'gpt-5-nano', owned_by: 'opencode' },
            { id: 'gpt-5.5', owned_by: 'opencode' },
            { id: 'hy3-preview-free', owned_by: 'opencode' },
          ],
        }),
      };
    }));

    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models.map((model) => model.id)).toEqual([
      'big-pickle',
      'gpt-5-nano',
      'hy3-preview-free',
    ]);
  });

  it('falls back to a valid unauthenticated model when stored zen model is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            opencode: {
              models: {
                'big-pickle': { cost: { input: 0, output: 0 } },
                'gpt-5-nano': { cost: { input: 0, output: 0 } },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'big-pickle', owned_by: 'opencode' },
            { id: 'gpt-5-nano', owned_by: 'opencode' },
          ],
        }),
      };
    }));

    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('gpt-5-nano');
  });
});
