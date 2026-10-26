import { describe, expect, it } from 'vitest';

import { createHostProviders, headerOfPackage, isLoopbackUrl, windowUpstreamOf } from './host-providers.js';

const OLLAMA = {
  name: 'Ollama (local)',
  package: 'aisdk:@ai-sdk/openai-compatible',
  settings: { baseURL: 'http://localhost:11434/v1' },
  models: { 'qwen3:8b': { modelID: 'qwen3:8b', name: 'Qwen3 8B' } },
};
const GATEWAY = {
  name: 'Lighthouse',
  package: 'aisdk:@ai-sdk/openai',
  env: ['LIGHTHOUSE_KEY'],
  settings: { baseURL: 'https://lighthouse-gw.example.dev/v1' },
  headers: { 'x-team': 'platform' },
  models: { 'gpt-5.5': { modelID: 'gpt-5.5' } },
};
const layers = ({ user = {}, userOverride = {}, project = {}, custom = {} } = {}) => () => ({ userConfig: user, userOverrideConfig: userOverride, projectConfig: project, customConfig: custom });

describe('the host\'s custom providers', () => {
  it('lists the providers the configuration defines with an SDK, without a key, and says what keeps each from a grant', async () => {
    const providers = createHostProviders({
      readLayers: layers({ user: { providers: { 'ollama-local': OLLAMA, lighthouse: GATEWAY, anthropic: { settings: { timeout: 1 } } } } }),
      readStoredKey: async (id) => (id === 'lighthouse' ? 'sk-stored' : null),
      hostEnvironment: {},
    });
    expect(await providers.list('/home/me/project')).toEqual([
      { id: 'ollama-local', name: 'Ollama (local)', package: 'aisdk:@ai-sdk/openai-compatible', baseURL: 'http://localhost:11434/v1', loopback: true, models: ['qwen3:8b'], hasKey: false, supported: true },
      { id: 'lighthouse', name: 'Lighthouse', package: 'aisdk:@ai-sdk/openai', baseURL: 'https://lighthouse-gw.example.dev/v1', loopback: false, models: ['gpt-5.5'], hasKey: true, supported: true },
    ]);
    expect(JSON.stringify(await providers.list('/home/me/project'))).not.toContain('sk-stored');
  });

  it('lists from the configuration alone while the host\'s OpenCode cannot be asked for its keys, and a read then fails', async () => {
    const providers = createHostProviders({ readLayers: layers({ user: { providers: { lighthouse: GATEWAY } } }), readStoredKey: async () => { throw new Error('OpenCode port is not available'); }, hostEnvironment: { LIGHTHOUSE_KEY: 'sk-env' } });
    expect((await providers.list('/p')).map((provider) => [provider.id, provider.hasKey])).toEqual([['lighthouse', true]]);
    await expect(providers.read('lighthouse', '/p')).rejects.toThrow('OpenCode port is not available');
  });

  it('says a provider without an http(s) address is unsupported, and leaves out an id a grant cannot name', async () => {
    const providers = createHostProviders({
      readLayers: layers({ user: { providers: { 'no-address': { ...GATEWAY, settings: {} }, 'ftp-address': { ...GATEWAY, settings: { baseURL: 'ftp://files.example/' } }, 'bad id!': GATEWAY, lighthouse: GATEWAY } } }),
      hostEnvironment: {},
    });
    expect((await providers.list('/p')).map((provider) => [provider.id, provider.supported])).toEqual([['no-address', false], ['ftp-address', false], ['lighthouse', true]]);
  });

  it('reads one provider with its key: the stored credential first, then a named variable, then a literal in the settings', async () => {
    const stored = createHostProviders({ readLayers: layers({ user: { providers: { lighthouse: GATEWAY } } }), readStoredKey: async () => 'sk-stored', hostEnvironment: { LIGHTHOUSE_KEY: 'sk-env' } });
    expect(await stored.read('lighthouse', '/p')).toMatchObject({ id: 'lighthouse', key: 'sk-stored', headers: { 'x-team': 'platform' }, models: { 'gpt-5.5': { modelID: 'gpt-5.5' } } });

    const fromEnv = createHostProviders({ readLayers: layers({ user: { providers: { lighthouse: GATEWAY } } }), hostEnvironment: { LIGHTHOUSE_KEY: 'sk-env' } });
    expect((await fromEnv.read('lighthouse', '/p')).key).toBe('sk-env');

    const literal = createHostProviders({ readLayers: layers({ user: { providers: { lighthouse: { ...GATEWAY, settings: { ...GATEWAY.settings, apiKey: 'sk-literal' } } } } }), hostEnvironment: {} });
    expect((await literal.read('lighthouse', '/p')).key).toBe('sk-literal');

    const none = createHostProviders({ readLayers: layers({ user: { providers: { 'ollama-local': OLLAMA } } }), hostEnvironment: {} });
    expect(await none.read('ollama-local', '/p')).toEqual({ id: 'ollama-local', name: 'Ollama (local)', package: 'aisdk:@ai-sdk/openai-compatible', baseURL: 'http://localhost:11434/v1', headers: {}, models: OLLAMA.models, key: null });
    expect(await none.read('anthropic', '/p')).toBeNull();
  });

  it('takes the highest layer that defines the provider, project over user, and reads the v1 spelling', async () => {
    const providers = createHostProviders({
      readLayers: layers({
        user: { provider: { lighthouse: { npm: '@ai-sdk/openai-compatible', name: 'Old', options: { baseURL: 'http://10.0.0.5/v1' } } } },
        project: { providers: { lighthouse: GATEWAY } },
      }),
      hostEnvironment: {},
    });
    expect((await providers.read('lighthouse', '/p')).name).toBe('Lighthouse');
    const onlyUser = createHostProviders({ readLayers: layers({ user: { provider: { lighthouse: { npm: '@ai-sdk/openai-compatible', name: 'Old', options: { baseURL: 'http://10.0.0.5/v1' } } } } }), hostEnvironment: {} });
    expect(await onlyUser.read('lighthouse', '/p')).toMatchObject({ name: 'Old', package: 'aisdk:@ai-sdk/openai-compatible', baseURL: 'http://10.0.0.5/v1' });
  });

  it('knows the header of each SDK the window can serve, and no other', () => {
    expect(headerOfPackage('aisdk:@ai-sdk/openai-compatible')).toBe('authorization');
    expect(headerOfPackage('aisdk:@ai-sdk/openai')).toBe('authorization');
    expect(headerOfPackage('aisdk:@ai-sdk/anthropic')).toBe('x-api-key');
    expect(headerOfPackage('aisdk:@ai-sdk/amazon-bedrock')).toBeNull();
    expect(headerOfPackage(undefined)).toBeNull();
  });

  it('sends "this machine" to the Docker host and leaves every other address as written', () => {
    expect(windowUpstreamOf('http://localhost:11434/v1')).toBe('http://host.docker.internal:11434/v1');
    expect(windowUpstreamOf('http://127.0.0.1:11434/v1/')).toBe('http://host.docker.internal:11434/v1/');
    expect(windowUpstreamOf('http://127.1.2.3:11434/v1')).toBe('http://host.docker.internal:11434/v1');
    expect(windowUpstreamOf('http://[::1]:8080/v1')).toBe('http://host.docker.internal:8080/v1');
    expect(windowUpstreamOf('http://0.0.0.0:1234/')).toBe('http://host.docker.internal:1234/');
    expect(windowUpstreamOf('http://192.168.1.23:11434/v1')).toBe('http://192.168.1.23:11434/v1');
    expect(windowUpstreamOf('https://lighthouse-gw.example.dev/v1')).toBe('https://lighthouse-gw.example.dev/v1');
    expect(windowUpstreamOf('http://localhost.example.com/v1')).toBe('http://localhost.example.com/v1');
    expect(windowUpstreamOf('ftp://localhost/')).toBeNull();
    expect(windowUpstreamOf('not a url')).toBeNull();
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.23:11434/v1')).toBe(false);
    expect(isLoopbackUrl('ftp://localhost/')).toBe(false);
  });
});
