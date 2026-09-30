import { describe, expect, it } from 'vitest';

import {
  isEnterpriseMode,
  isNetworkAccessBlocked,
  isProviderConnectRequest,
  policyFilePaths,
  publicEnterprisePolicy,
  readEnterprisePolicy,
} from './enterprise-mode.js';

const missing = () => {
  throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
};

/** A machine with `files` (path → content) and nothing else. */
const machine = (files, { platform = 'linux', env = {} } = {}) => ({
  platform,
  env,
  readFile: (filePath) => {
    if (!(filePath in files)) missing();
    const content = files[filePath];
    if (content instanceof Error) throw content;
    return content;
  },
});

const LINUX_POLICY = '/etc/openchamber/policy.json';

describe('enterprise policy', () => {
  it('is off with no policy file and no environment variable', () => {
    expect(readEnterprisePolicy(machine({}))).toEqual({
      enterpriseMode: false,
      source: null,
      organization: null,
      policyError: null,
      relayUrl: null,
      jev: null,
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
    });
  });

  it('turns on from the environment variable alone', () => {
    const options = machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: 'true' } });
    expect(isEnterpriseMode(options)).toBe(true);
    expect(readEnterprisePolicy(options).source).toBe('environment');
  });

  it('turns on from the policy file and carries its organization and pins', () => {
    const policy = readEnterprisePolicy(machine({
      [LINUX_POLICY]: JSON.stringify({
        enterpriseMode: true,
        organization: 'Acme',
        relayUrl: 'wss://relay.acme.test/ws',
        jev: { url: 'https://llm.acme.test/v1', model: 'acme-jev', apiKey: 'k' },
      }),
    }));
    expect(policy).toEqual({
      enterpriseMode: true,
      source: 'policy-file',
      organization: 'Acme',
      policyError: null,
      relayUrl: 'wss://relay.acme.test/ws',
      jev: { url: 'https://llm.acme.test/v1', model: 'acme-jev', apiKey: 'k' },
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
    });
  });

  it('ignores the environment\'s pins and network allowance once the file turns enterprise mode on', () => {
    const policy = readEnterprisePolicy(machine(
      { [LINUX_POLICY]: '{"enterpriseMode": true}' },
      { env: {
        OPENCHAMBER_RELAY_URL: 'wss://my-relay.test/ws',
        OPENCHAMBER_JEV_URL: 'https://my-endpoint.test',
        OPENCHAMBER_ALLOW_NETWORK_ACCESS: '1',
      } },
    ));
    expect(policy.relayUrl).toBeNull();
    expect(policy.jev).toBeNull();
    expect(policy.allowNetworkAccess).toBe(false);
  });

  it('takes the pins and network allowance from the environment when the environment turns it on', () => {
    const policy = readEnterprisePolicy(machine({}, { env: {
      OPENCHAMBER_ENTERPRISE_MODE: '1',
      OPENCHAMBER_RELAY_URL: 'wss://relay.acme.test/ws',
      OPENCHAMBER_ALLOW_NETWORK_ACCESS: 'true',
    } }));
    expect(policy.relayUrl).toBe('wss://relay.acme.test/ws');
    expect(policy.allowNetworkAccess).toBe(true);
  });

  it('takes allowed extension repositories from the file, or from the environment only when the file does not govern', () => {
    const env = { OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/me/ext, https://github.com/me/other' };
    expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }, { env })).allowedExtensions).toEqual([]);
    expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowedExtensions": ["https://github.com/acme/ext"]}' }, { env })).allowedExtensions)
      .toEqual(['https://github.com/acme/ext']);
    expect(readEnterprisePolicy(machine({}, { env: { ...env, OPENCHAMBER_ENTERPRISE_MODE: '1' } })).allowedExtensions)
      .toEqual(['https://github.com/me/ext', 'https://github.com/me/other']);
  });

  describe('network access', () => {
    it('is blocked in enterprise mode unless allowed', () => {
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }))).toBe(true);
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowNetworkAccess": true}' }))).toBe(false);
      expect(isNetworkAccessBlocked(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' } }))).toBe(true);
      expect(isNetworkAccessBlocked(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOW_NETWORK_ACCESS: '1' } }))).toBe(false);
    });

    it('is never blocked outside enterprise mode', () => {
      expect(isNetworkAccessBlocked(machine({}))).toBe(false);
    });

    it('stays blocked when the policy file is broken', () => {
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"allowNetworkAccess": tru' }))).toBe(true);
    });
  });

  it('cannot be turned off by the environment once the file turns it on', () => {
    const options = machine(
      { [LINUX_POLICY]: '{"enterpriseMode": true}' },
      { env: { OPENCHAMBER_ENTERPRISE_MODE: '0' } },
    );
    expect(isEnterpriseMode(options)).toBe(true);
  });

  it('lets the environment turn it on when the file leaves it off', () => {
    const options = machine(
      { [LINUX_POLICY]: '{"enterpriseMode": false}' },
      { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' } },
    );
    expect(readEnterprisePolicy(options).source).toBe('environment');
  });

  it('prefers values from the file over their environment variables, and fills the gaps from the environment', () => {
    const env = {
      OPENCHAMBER_RELAY_URL: 'wss://env-relay.test/ws',
      OPENCHAMBER_JEV_URL: 'https://env-jev.test',
      OPENCHAMBER_JEV_MODEL: 'env-model',
    };
    const fileRelayOnly = readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"relayUrl": "wss://file-relay.test/ws"}' }, { env }));
    expect(fileRelayOnly.relayUrl).toBe('wss://file-relay.test/ws');
    expect(fileRelayOnly.jev).toEqual({ url: 'https://env-jev.test', model: 'env-model', apiKey: null });

    const fileJev = readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"jev": {"url": "https://file-jev.test"}}' }, { env }));
    // The file's endpoint comes whole: the environment's model does not mix into it.
    expect(fileJev.jev).toEqual({ url: 'https://file-jev.test', model: null, apiKey: null });
  });

  it.each([
    ['not JSON', '{enterpriseMode: true'],
    ['not an object', '[true]'],
    ['a non-boolean switch', '{"enterpriseMode": "yes"}'],
    ['a non-string relay', '{"relayUrl": 42}'],
    ['a Jev model without a URL', '{"jev": {"model": "m"}}'],
  ])('keeps enterprise mode on and pins nothing when the file is %s', (_label, content) => {
    const policy = readEnterprisePolicy(machine(
      { [LINUX_POLICY]: content },
      { env: { OPENCHAMBER_RELAY_URL: 'wss://env-relay.test/ws', OPENCHAMBER_JEV_URL: 'https://env-jev.test' } },
    ));
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.source).toBe('policy-file');
    expect(policy.policyError).toContain(LINUX_POLICY);
    expect(policy.relayUrl).toBeNull();
    expect(policy.jev).toBeNull();
  });

  it('keeps enterprise mode on when the file exists but cannot be read', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: denied }));
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.policyError).toContain('permission denied');
  });

  it('reads a file saved with a byte-order mark', () => {
    const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: '\uFEFF{"enterpriseMode": true, "organization": "Acme"}' }));
    expect(policy.policyError).toBeNull();
    expect(policy.organization).toBe('Acme');
  });

  it('ignores unknown keys so newer policy files still apply', () => {
    expect(isEnterpriseMode(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "future": 1}' }))).toBe(true);
  });

  it('never exposes pinned endpoints or keys to clients', () => {
    const policy = publicEnterprisePolicy(machine({
      [LINUX_POLICY]: '{"enterpriseMode": true, "organization": "Acme", "jev": {"url": "https://x.test", "apiKey": "secret"}}',
    }));
    expect(policy).toEqual({ enterpriseMode: true, source: 'policy-file', organization: 'Acme', policyError: null, networkAccessBlocked: true });
  });

  describe('file location', () => {
    it('is fixed per platform', () => {
      expect(policyFilePaths({ platform: 'darwin', env: {} })).toEqual(['/Library/Application Support/OpenChamber/policy.json']);
      expect(policyFilePaths({ platform: 'linux', env: {} })).toEqual([LINUX_POLICY]);
      expect(policyFilePaths({ platform: 'win32', env: {} })).toEqual(['C:\\ProgramData\\OpenChamber\\policy.json']);
    });

    it('on Windows reads C:\\ProgramData first, so redirecting ProgramData cannot hide the policy', () => {
      const env = { ProgramData: 'D:\\Elsewhere' };
      expect(policyFilePaths({ platform: 'win32', env })).toEqual([
        'C:\\ProgramData\\OpenChamber\\policy.json',
        'D:\\Elsewhere\\OpenChamber\\policy.json',
      ]);
      const options = machine({
        'C:\\ProgramData\\OpenChamber\\policy.json': '{"enterpriseMode": true}',
        'D:\\Elsewhere\\OpenChamber\\policy.json': '{"enterpriseMode": false}',
      }, { platform: 'win32', env });
      expect(isEnterpriseMode(options)).toBe(true);
    });

    it('on Windows falls back to the ProgramData folder when the system drive is not C:', () => {
      const options = machine(
        { 'D:\\ProgramData\\OpenChamber\\policy.json': '{"enterpriseMode": true}' },
        { platform: 'win32', env: { ProgramData: 'D:\\ProgramData' } },
      );
      expect(isEnterpriseMode(options)).toBe(true);
    });
  });

  describe('provider-connect requests', () => {
    it.each([
      '/api/integration/openai/connect/key',
      '/api/integration/openai/connect/key?directory=%2Fp',
      '/api/integration/anthropic/connect/oauth',
      '/api/integration/anthropic/connect/oauth/att_1/complete',
      '/api/integration/github-copilot/connect/command',
      '/api/experimental/integration/wellknown',
    ])('refuses POST %s', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(true);
    });

    it.each([
      ['GET', '/api/integration/anthropic/connect/oauth/att_1'],
      ['DELETE', '/api/integration/anthropic/connect/oauth/att_1'],
      ['GET', '/api/integration'],
      ['POST', '/api/session'],
      ['DELETE', '/api/credential/cred_1'],
    ])('leaves %s %s alone', (method, requestPath) => {
      expect(isProviderConnectRequest(method, requestPath)).toBe(false);
    });
  });
});
