import { beforeEach, describe, expect, it, vi } from 'vitest';

const userPath = '/tmp/openchamber-test/opencode/config.json';

let readConfigLayersMock;
let writeConfigMock;

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

async function loadProvidersModule(userConfig) {
  vi.resetModules();
  readConfigLayersMock = vi.fn(() => ({
    userConfig,
    projectConfig: {},
    customConfig: {},
    mergedConfig: userConfig,
    paths: {
      userPath,
      projectPath: null,
      customPath: null,
    },
  }));
  writeConfigMock = vi.fn();

  vi.doMock('./shared.js', () => ({
    CONFIG_FILE: userPath,
    readConfigLayers: readConfigLayersMock,
    isPlainObject,
    getConfigForPath: vi.fn(() => userConfig),
    writeConfig: writeConfigMock,
  }));

  return import('./providers.js');
}

describe('provider model context limits', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads user-scoped model context limits from OpenCode provider config', async () => {
    const providers = await loadProvidersModule({
      provider: {
        anthropic: {
          models: {
            'claude-sonnet': {
              limit: {
                context: 200000,
                output: 8192,
              },
            },
            'claude-haiku': {
              limit: {
                context: '200k',
                output: 4096,
              },
            },
            'claude-opus': {
              name: 'Claude Opus',
            },
          },
        },
      },
    });

    expect(providers.getUserProviderModelContextLimits('anthropic')).toEqual({
      providerId: 'anthropic',
      models: {
        'claude-sonnet': {
          context: 200000,
          output: 8192,
        },
      },
      source: {
        scope: 'user',
        path: userPath,
      },
    });
  });

  it('writes a custom context cap without clobbering other model override fields', async () => {
    const userConfig = {
      provider: {
        anthropic: {
          models: {
            'claude-sonnet': {
              name: 'Claude Sonnet',
              limit: {
                output: 4096,
              },
              temperature: 0.2,
            },
          },
        },
      },
    };
    const providers = await loadProvidersModule(userConfig);

    const result = providers.updateUserProviderModelContextLimit(
      'anthropic',
      'claude-sonnet',
      120000,
      8192,
      200000,
    );

    expect(result).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      context: 120000,
      output: 8192,
      source: {
        scope: 'user',
        path: userPath,
      },
    });
    expect(userConfig.provider.anthropic.models['claude-sonnet']).toEqual({
      name: 'Claude Sonnet',
      limit: {
        output: 8192,
        context: 120000,
      },
      temperature: 0.2,
    });
    expect(writeConfigMock).toHaveBeenCalledWith(userConfig, userPath);
  });

  it('clears a custom context cap and removes empty model overrides', async () => {
    const userConfig = {
      provider: {
        anthropic: {
          apiKey: 'keep-me',
          models: {
            'claude-sonnet': {
              limit: {
                context: 120000,
                output: 8192,
              },
            },
            'claude-haiku': {
              limit: {
                context: 50000,
                output: 4096,
              },
            },
          },
        },
      },
    };
    const providers = await loadProvidersModule(userConfig);

    const result = providers.updateUserProviderModelContextLimit(
      'anthropic',
      'claude-sonnet',
      null,
      null,
      200000,
    );

    expect(result).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      context: null,
      source: {
        scope: 'user',
        path: userPath,
      },
    });
    expect(userConfig.provider.anthropic).toEqual({
      apiKey: 'keep-me',
      models: {
        'claude-haiku': {
          limit: {
            context: 50000,
            output: 4096,
          },
        },
      },
    });
    expect(writeConfigMock).toHaveBeenCalledWith(userConfig, userPath);
  });

  it('rejects a context cap above the advertised max before writing config', async () => {
    const providers = await loadProvidersModule({});

    expect(() => providers.updateUserProviderModelContextLimit(
      'anthropic',
      'claude-sonnet',
      250000,
      8192,
      200000,
    )).toThrow('Context limit cannot exceed advertised context limit (200000)');
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it('requires an output limit when setting a custom context cap', async () => {
    const providers = await loadProvidersModule({});

    expect(() => providers.updateUserProviderModelContextLimit(
      'anthropic',
      'claude-sonnet',
      120000,
      null,
      200000,
    )).toThrow('Output limit is required to set a context cap');
    expect(writeConfigMock).not.toHaveBeenCalled();
  });
});
