import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(),
  writeAuthFile: vi.fn(),
}));

vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));

const { readAuthFile } = await import('../opencode/auth.js');
const { readConfig } = await import('../opencode/shared.js');
const { listAuthenticatedProviders } = await import('./index.js');

beforeEach(() => {
  readAuthFile.mockReset();
  readConfig.mockReset();
});

describe('listAuthenticatedProviders', () => {
  it('includes and deduplicates providers authenticated through config', () => {
    readAuthFile.mockReturnValue({
      openai: { type: 'api', key: 'auth-key' },
    });
    readConfig.mockReturnValue({
      provider: {
        custom: { options: { apiKey: 'config-key' } },
        openai: { options: { apiKey: 'config-openai-key' } },
      },
    });

    expect(listAuthenticatedProviders()).toEqual(['openai', 'custom']);
  });

  it('keeps unusable auth entries out while including config-authenticated ids', () => {
    readAuthFile.mockReturnValue({
      anthropic: { type: 'api', key: '' },
      openai: { type: 'oauth' },
    });
    readConfig.mockReturnValue({
      provider: {
        custom: { options: { apiKey: 'config-key' } },
        blank: { options: { apiKey: '   ' } },
      },
    });

    expect(listAuthenticatedProviders()).toEqual(['custom']);
  });
});
