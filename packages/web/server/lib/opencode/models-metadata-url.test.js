import { describe, expect, it } from 'vitest';

import { isModelsDevUrlPinned, resolveModelsDevUrl } from './models-metadata.js';

const policyFile = (policy) => ({
  platform: 'linux',
  env: {},
  readFile: (filePath) => {
    if (filePath !== '/etc/openchamber/policy.json' || policy === null) {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    }
    return JSON.stringify(policy);
  },
});

describe('resolveModelsDevUrl', () => {
  it('uses models.dev when the policy pins nothing', () => {
    expect(resolveModelsDevUrl(undefined, policyFile(null))).toBe('https://models.dev/api.json');
    expect(isModelsDevUrlPinned(policyFile(null))).toBe(false);
  });

  it('keeps the caller default when the policy pins nothing', () => {
    expect(resolveModelsDevUrl('https://models.example.test', policyFile({ enterpriseMode: true }))).toBe('https://models.example.test');
  });

  it('prefers the pinned URL over both the default and the caller default', () => {
    const options = policyFile({ modelsDevUrl: 'https://nginx.corp.test/models/api.json' });
    expect(resolveModelsDevUrl(undefined, options)).toBe('https://nginx.corp.test/models/api.json');
    expect(resolveModelsDevUrl('https://models.example.test', options)).toBe('https://nginx.corp.test/models/api.json');
    expect(isModelsDevUrlPinned(options)).toBe(true);
  });

  it('falls back to the default, unpinned, when the pinned value is malformed', () => {
    const options = policyFile({ modelsDevUrl: 'not a url' });
    expect(resolveModelsDevUrl(undefined, options)).toBe('https://models.dev/api.json');
    expect(isModelsDevUrlPinned(options)).toBe(false);
  });
});
