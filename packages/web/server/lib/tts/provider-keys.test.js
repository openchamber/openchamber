import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { approvedProviderKey, describeKeyProviders, readKeyProviders, resolveProviderKey } from './provider-keys.js';
import { approveProviderServer } from './voice-keys.js';

const provider = (id, settings, extra = {}) => ({ id, name: id, activation: 'enabled', package: '@ai-sdk/openai-compatible', settings, ...extra });
const stored = (integrationID, key, extra = {}) => ({ id: `credential-${integrationID}`, integrationID, label: '', active: true, value: { type: 'key', key }, ...extra });

const openCode = ({ providers = [], credentials = [], environment = {}, launchEnvironment = null } = {}) => configureOpenCodeCredentials({
  list: async () => credentials,
  listProviders: async () => providers,
  listEnvironmentKeys: async () => environment,
  launchEnvironment: () => launchEnvironment,
});

afterEach(() => {
  vi.unstubAllEnvs();
  configureOpenCodeCredentials(null);
  fs.rmSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), { force: true });
});

const GATEWAY = 'http://gateway.test:8317';

describe('OpenCode providers that have a key', () => {
  it('reads the stored credential first, then the provider key with {env:} resolved, then the key of its environment connection', async () => {
    openCode({
      launchEnvironment: { VOICE_TEST_KEY: 'sk-from-env' },
      providers: [
        provider('stored', { apiKey: 'sk-config-loses', baseURL: `${GATEWAY}/v1` }, { name: 'Stored' }),
        provider('plain', { apiKey: 'sk-config', baseURL: 'https://api.plain.test/v1/chat?x=1' }, { name: 'Plain' }),
        provider('viaenv', { apiKey: '{env:VOICE_TEST_KEY}' }),
        provider('ambient', { apiKey: 'sk-config-beats-ambient' }),
        provider('connected', {}),
        provider('keyless', { baseURL: 'http://keyless.test/v1' }),
        provider('unset', { apiKey: '{env:VOICE_TEST_UNSET}' }),
        provider('blank', { apiKey: '   ' }),
        provider('logged', {}),
      ],
      credentials: [
        stored('stored', 'sk-stored'),
        { id: 'login', integrationID: 'logged', label: '', active: true, value: { type: 'oauth', methodID: 'login', access: 'oauth-access-token', refresh: 'oauth-refresh-token', expires: 0 } },
      ],
      environment: { ambient: 'sk-ambient', connected: 'sk-from-connection', logged: 'sk-ambient-too' },
    });

    const providers = await readKeyProviders();

    expect(Object.fromEntries(providers.map(({ id, key, origin, name, credentialID }) => [id, { key, origin, name, credentialID }]))).toEqual({
      stored: { key: 'sk-stored', origin: GATEWAY, name: 'Stored', credentialID: 'credential-stored' },
      plain: { key: 'sk-config', origin: 'https://api.plain.test', name: 'Plain', credentialID: undefined },
      viaenv: { key: 'sk-from-env', origin: null, name: 'viaenv', credentialID: undefined },
      ambient: { key: 'sk-config-beats-ambient', origin: null, name: 'ambient', credentialID: undefined },
      connected: { key: 'sk-from-connection', origin: null, name: 'connected', credentialID: undefined },
    });
  });

  it('resolves {env:} against the environment OpenCode was launched with, not this server\'s own', async () => {
    vi.stubEnv('VOICE_TEST_KEY', 'sk-of-this-server');
    vi.stubEnv('VOICE_TEST_ONLY_HERE', 'sk-only-this-server');
    openCode({
      providers: [
        provider('both', { apiKey: '{env:VOICE_TEST_KEY}' }),
        provider('onlyhere', { apiKey: '{env:VOICE_TEST_ONLY_HERE}' }),
        provider('blank', { apiKey: '{env:VOICE_TEST_BLANK}' }),
      ],
      launchEnvironment: { VOICE_TEST_KEY: 'sk-of-opencode', VOICE_TEST_BLANK: '  ' },
    });

    expect((await readKeyProviders()).map(({ id, key }) => [id, key])).toEqual([['both', 'sk-of-opencode']]);
  });

  it.each([
    ['a stored key equal to the placeholder', 'public', { credentials: [stored('opencode', 'public')] }],
    ['an environment connection', 'sk-from-connection', { environment: { opencode: 'sk-from-connection' } }],
    ['an environment connection equal to the placeholder', 'public', { environment: { opencode: 'public' } }],
    ['an explicit environment reference equal to the placeholder', 'public', { launchEnvironment: { VOICE_TEST_KEY: 'public' } }, '{env:VOICE_TEST_KEY}'],
  ])('offers the OpenCode provider with %s', async (_source, key, credentials, apiKey = 'public') => {
    openCode({ providers: [provider('opencode', { apiKey })], ...credentials });

    expect(await readKeyProviders()).toMatchObject([{ id: 'opencode', key }]);
  });

  it('does not offer a provider\'s {env:} key when the launch environment is not available (an external OpenCode)', async () => {
    vi.stubEnv('VOICE_TEST_KEY', 'sk-of-this-server');
    openCode({
      providers: [provider('viaenv', { apiKey: '{env:VOICE_TEST_KEY}' }), provider('typed', { apiKey: 'sk-config' })],
      launchEnvironment: null,
    });

    expect((await readKeyProviders()).map(({ id, key }) => [id, key])).toEqual([['typed', 'sk-config']]);
    expect((await describeKeyProviders(GATEWAY)).map(({ id }) => id)).toEqual(['typed']);
    expect(await approvedProviderKey('viaenv', `${GATEWAY}/v1`)).toBeUndefined();
  });

  it('lists only model providers: a search integration with a key is not a candidate', async () => {
    openCode({
      providers: [provider('groq', {})],
      credentials: [stored('groq', 'sk-groq'), stored('tavily', 'tvly-madeup'), stored('exa', 'exa-madeup')],
      environment: { exa: 'exa-from-env' },
    });

    expect((await readKeyProviders()).map(({ id }) => id)).toEqual(['groq']);
    expect(await approvedProviderKey('tavily', `${GATEWAY}/v1`)).toBeUndefined();
    expect((await describeKeyProviders(GATEWAY)).map(({ id }) => id)).toEqual(['groq']);
  });

  it('uses the credential of the integration a provider names', async () => {
    openCode({ providers: [provider('mirror', {}, { integrationID: 'openai' })], credentials: [stored('openai', 'sk-openai')] });

    expect((await readKeyProviders()).map(({ id, key }) => [id, key])).toEqual([['mirror', 'sk-openai']]);
  });

  it('takes the address from the running OpenCode, not from any config file', async () => {
    const file = path.join(process.env.OPENCHAMBER_DATA_DIR, 'legacy-config.json');
    fs.writeFileSync(file, JSON.stringify({ provider: { moved: { api: `${GATEWAY}/v1`, options: { apiKey: 'sk-moved', baseURL: 'https://chat.moved.test/v1' } } } }));
    vi.stubEnv('OPENCODE_CONFIG', file);
    openCode({ providers: [provider('moved', { apiKey: 'sk-moved', baseURL: 'https://chat.moved.test/v1' })] });

    expect((await readKeyProviders()).map(({ origin }) => origin)).toEqual(['https://chat.moved.test']);
    expect((await describeKeyProviders(`${GATEWAY}/v1`))[0]).toMatchObject({ matches: false });
    expect((await describeKeyProviders('https://chat.moved.test/audio'))[0]).toMatchObject({ matches: true });
  });

  it('lists a provider that only inline or launch configuration defines, and gives one without an address no origin', async () => {
    openCode({ providers: [provider('inline', { apiKey: 'sk-inline', baseURL: `${GATEWAY}/v1` }), provider('bare', { apiKey: 'sk-bare' })] });

    expect((await readKeyProviders()).map(({ id, origin }) => [id, origin])).toEqual([['inline', GATEWAY], ['bare', null]]);
    expect((await describeKeyProviders(`${GATEWAY}/v1`)).map(({ id, matches }) => [id, matches])).toEqual([['inline', true], ['bare', false]]);
    expect((await resolveProviderKey(undefined, `${GATEWAY}/v1`)).provider.id).toBe('inline');
    expect(await resolveProviderKey('bare', `${GATEWAY}/v1`)).toMatchObject({ approvedKey: undefined });
  });

  it('says so when OpenCode cannot be asked, and sends no provider key meanwhile', async () => {
    configureOpenCodeCredentials({ list: async () => [stored('gateway', 'sk-gateway')], listProviders: async () => { throw new Error('OpenCode is not connected yet'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(readKeyProviders()).rejects.toThrow('not connected');
    await expect(describeKeyProviders(GATEWAY)).rejects.toThrow('not connected');
    expect(await resolveProviderKey('gateway', `${GATEWAY}/v1`)).toBeNull();
    expect(await approvedProviderKey(undefined, `${GATEWAY}/v1`)).toBeUndefined();
    warn.mockRestore();
  });

  it('counts a failed lookup of the environment connections as unreadable, not as none', async () => {
    configureOpenCodeCredentials({
      list: async () => [stored('twin', 'sk-twin')],
      listProviders: async () => [provider('gateway', { baseURL: `${GATEWAY}/v1` }), provider('twin', { baseURL: `${GATEWAY}/v1` })],
      listEnvironmentKeys: async () => { throw new Error('integration list failed'); },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(readKeyProviders()).rejects.toThrow('integration list failed');
    await expect(describeKeyProviders(GATEWAY)).rejects.toThrow('integration list failed');
    expect(await resolveProviderKey(undefined, `${GATEWAY}/v1`)).toBeNull();
    warn.mockRestore();
  });

  it('leaves out a key that would change in an HTTP header, and says so once, without the key', async () => {
    openCode({ providers: [provider('spaced', {}), provider('plain', {})], credentials: [stored('spaced', 'sk-spaced-secret '), stored('plain', 'sk-plain')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await readKeyProviders()).map(({ id }) => id)).toEqual(['plain']);
    expect((await describeKeyProviders(GATEWAY)).map(({ id }) => id)).toEqual(['plain']);

    expect(warn.mock.calls.filter(([message]) => String(message).includes('spaced'))).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-spaced-secret');
    warn.mockRestore();
  });

  it('lists nothing without providers, and says what the browser may know without a key', async () => {
    openCode();

    expect(await readKeyProviders()).toEqual([]);
    expect(await describeKeyProviders(`${GATEWAY}/v1`)).toEqual([]);
  });

  it('describes each provider for an address without ever carrying a key', async () => {
    openCode({
      providers: [provider('stored', { baseURL: `${GATEWAY}/v1` }, { name: 'Stored' }), provider('other', { apiKey: 'sk-other', baseURL: 'https://other.test/v1' }, { name: 'Other' })],
      credentials: [stored('stored', 'sk-stored')],
    });
    const other = (await readKeyProviders()).find(({ id }) => id === 'other');
    approveProviderServer(other, `${GATEWAY}/v1`, (await describeKeyProviders(GATEWAY))[1].keyId);

    const described = await describeKeyProviders(`${GATEWAY}/other/path`);

    expect(described).toEqual([
      { id: 'stored', name: 'Stored', keyId: expect.any(String), matches: true, approved: false },
      { id: 'other', name: 'Other', keyId: expect.any(String), matches: false, approved: true },
    ]);
    expect(JSON.stringify(described)).not.toContain('sk-');
    expect(await describeKeyProviders(undefined)).toEqual([
      expect.objectContaining({ id: 'stored', matches: false, approved: false }),
      expect.objectContaining({ id: 'other', matches: false, approved: false }),
    ]);
  });
});

describe('which provider key may go to a voice server', () => {
  const setUp = () => openCode({
    providers: [
      provider('gateway', { baseURL: `${GATEWAY}/v1` }),
      provider('twin', { baseURL: `${GATEWAY}/other/v1` }),
      provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' }),
    ],
    credentials: [stored('gateway', 'sk-gateway'), stored('twin', 'sk-twin'), stored('elsewhere', 'sk-elsewhere')],
  });
  const approve = async (id, address) => {
    const resolved = await resolveProviderKey(id, address);
    return approveProviderServer(resolved.provider, address, resolved.keyId);
  };

  it('sends a provider key to no origin before the user approved it for that provider, its own origin included', async () => {
    setUp();

    for (const address of ['https://api.elsewhere.test/audio', 'https://api.elsewhere.test:8443/v1', `${GATEWAY}/v1`, 'http://voices.test:8880/v1']) {
      expect(await approvedProviderKey('elsewhere', address)).toBeUndefined();
    }
    expect(await approvedProviderKey(undefined, 'https://api.elsewhere.test/v1/audio')).toBeUndefined();
    expect(await resolveProviderKey('elsewhere', 'https://api.elsewhere.test/audio')).toMatchObject({ approvedKey: undefined, keyId: expect.any(String) });
  });

  it('sends it to an origin after the user approved that origin for that provider, and to no other origin', async () => {
    setUp();
    const resolved = await resolveProviderKey('elsewhere', 'http://voices.test:8880/v1');

    expect(approveProviderServer(resolved.provider, 'http://voices.test:8880/v1', 'guess')).toBe('refused');
    expect(approveProviderServer(resolved.provider, 'ftp://voices.test/v1', resolved.keyId)).toBe('refused');
    expect(await approvedProviderKey('elsewhere', 'http://voices.test:8880/v1')).toBeUndefined();

    expect(approveProviderServer(resolved.provider, 'http://voices.test:8880/v1', resolved.keyId)).toBe('added');
    expect(approveProviderServer(resolved.provider, 'http://voices.test:8880/other', resolved.keyId)).toBe('kept');

    expect(await approvedProviderKey('elsewhere', 'http://voices.test:8880/v1')).toBe('sk-elsewhere');
    expect(await approvedProviderKey('elsewhere', 'http://voices.test:9999/v1')).toBeUndefined();
    expect(await approvedProviderKey('elsewhere', 'https://voices.test:8880/v1')).toBeUndefined();
    expect(await approvedProviderKey('elsewhere', 'https://api.elsewhere.test/v1')).toBeUndefined();
    expect(await approvedProviderKey('gateway', 'http://voices.test:8880/v1')).toBeUndefined();
    expect(await approvedProviderKey('elsewhere', 'not an address')).toBeUndefined();
    expect(await approvedProviderKey('elsewhere', undefined)).toBeUndefined();
  });

  it('preselects the one provider with the same origin when the user has not chosen, and still waits for the approval', async () => {
    setUp();

    expect((await resolveProviderKey(undefined, 'https://api.elsewhere.test/v1/audio')).provider.id).toBe('elsewhere');
    expect(await resolveProviderKey(undefined, 'https://other.test/v1')).toBeNull();
    expect(await approvedProviderKey(undefined, 'https://api.elsewhere.test/v1/audio')).toBeUndefined();

    expect(await approve('elsewhere', 'https://api.elsewhere.test/v1/audio')).toBe('added');
    expect(await approvedProviderKey(undefined, 'https://api.elsewhere.test/v1/audio')).toBe('sk-elsewhere');
    expect(await approvedProviderKey(undefined, 'https://other.test/v1')).toBeUndefined();
  });

  it('takes no provider when two have the same origin, or when the user chose none or another provider', async () => {
    setUp();
    await approve('gateway', `${GATEWAY}/other/v1`);
    await approve('elsewhere', 'https://api.elsewhere.test/v1');

    expect(await approvedProviderKey(undefined, `${GATEWAY}/v1`)).toBeUndefined();
    expect(await approvedProviderKey('', 'https://api.elsewhere.test/v1')).toBeUndefined();
    expect(await approvedProviderKey('gateway', 'https://api.elsewhere.test/v1')).toBeUndefined();
    expect(await approvedProviderKey('gateway', `${GATEWAY}/other/v1`)).toBe('sk-gateway');
    expect(await approvedProviderKey('no-such-provider', 'https://api.elsewhere.test/v1')).toBeUndefined();
  });
});

describe('an approval belongs to the credential that was approved', () => {
  const VOICES = 'http://voices.test:8880/v1';
  const approve = async (id) => {
    const resolved = await resolveProviderKey(id, VOICES);
    return approveProviderServer(resolved.provider, VOICES, resolved.keyId);
  };

  it('is lost when another account becomes the active credential of the provider', async () => {
    const providers = [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })];
    openCode({ providers, credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    expect(await approve('elsewhere')).toBe('added');
    expect(await approvedProviderKey('elsewhere', VOICES)).toBe('sk-first');

    openCode({ providers, credentials: [stored('elsewhere', 'sk-first', { id: 'account-1', active: false }), stored('elsewhere', 'sk-second', { id: 'account-2' })] });
    expect(await approvedProviderKey('elsewhere', VOICES)).toBeUndefined();
    expect((await describeKeyProviders(VOICES))[0]).toMatchObject({ approved: false });

    expect(await approve('elsewhere')).toBe('added');
    expect(await approvedProviderKey('elsewhere', VOICES)).toBe('sk-second');
  });

  it('is lost when the same credential entry holds other key bytes, and comes back with a new approval', async () => {
    const providers = [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })];
    openCode({ providers, credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    expect(await approve('elsewhere')).toBe('added');
    expect(await approvedProviderKey('elsewhere', VOICES)).toBe('sk-first');

    openCode({ providers, credentials: [stored('elsewhere', 'sk-replaced', { id: 'account-1' })] });
    expect(await approvedProviderKey('elsewhere', VOICES)).toBeUndefined();
    expect((await describeKeyProviders(VOICES))[0]).toMatchObject({ approved: false });

    expect(await approve('elsewhere')).toBe('added');
    expect(await approvedProviderKey('elsewhere', VOICES)).toBe('sk-replaced');
    openCode({ providers, credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    expect(await approvedProviderKey('elsewhere', VOICES)).toBeUndefined();
  });

  it('names the entry id and the keyed digest of a stored key, and the digest alone for any other', async () => {
    openCode({ providers: [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })], credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    await approve('elsewhere');
    openCode({ providers: [provider('configured', { apiKey: 'sk-configured', baseURL: 'https://api.configured.test/v1' })] });
    await approve('configured');

    const saved = JSON.parse(fs.readFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), 'utf8'));

    expect(saved.providerApprovals).toEqual([
      { provider: 'elsewhere', origin: 'http://voices.test:8880', entry: 'account-1', digest: expect.any(String) },
      { provider: 'configured', origin: 'http://voices.test:8880', digest: expect.any(String) },
    ]);
  });

  it('is lost when a removed provider id comes back with a credential of its own', async () => {
    const providers = [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })];
    openCode({ providers, credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    await approve('elsewhere');

    openCode({ providers: [], credentials: [] });
    openCode({ providers, credentials: [stored('elsewhere', 'sk-reused', { id: 'account-9' })] });

    expect(await approvedProviderKey('elsewhere', VOICES)).toBeUndefined();
  });

  it('is lost when a key that has no credential entry changes, and returns when the same key does', async () => {
    const withKey = (apiKey) => openCode({ providers: [provider('configured', { apiKey, baseURL: 'https://api.configured.test/v1' })] });
    withKey('sk-configured-first');
    expect(await approve('configured')).toBe('added');
    expect(await approvedProviderKey('configured', VOICES)).toBe('sk-configured-first');

    withKey('sk-configured-second');
    expect(await approvedProviderKey('configured', VOICES)).toBeUndefined();

    withKey('sk-configured-first');
    expect(await approvedProviderKey('configured', VOICES)).toBe('sk-configured-first');
  });

  it('is kept in a private file that holds neither the key nor an unkeyed hash of it', async () => {
    openCode({ providers: [provider('configured', { apiKey: 'sk-configured-madeup', baseURL: 'https://api.configured.test/v1' })] });
    await approve('configured');

    const file = path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(saved.identitySecret).toHaveLength(43);
    expect(saved.providerApprovals).toEqual([{ provider: 'configured', origin: 'http://voices.test:8880', digest: expect.any(String) }]);
    expect(JSON.stringify(saved)).not.toContain('sk-configured-madeup');
    expect(saved.providerApprovals[0].digest).not.toBe(crypto.createHash('sha256').update('sk-configured-madeup').digest('base64url'));
    expect(saved.providerApprovals[0].digest).toBe(crypto.createHmac('sha256', saved.identitySecret).update('sk-configured-madeup').digest('base64url'));
  });

  it('keeps one approval for each provider and origin', async () => {
    openCode({ providers: [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })], credentials: [stored('elsewhere', 'sk-first', { id: 'account-1' })] });
    await approve('elsewhere');
    openCode({ providers: [provider('elsewhere', { baseURL: 'https://api.elsewhere.test/v1' })], credentials: [stored('elsewhere', 'sk-second', { id: 'account-2' })] });
    await approve('elsewhere');

    const saved = JSON.parse(fs.readFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), 'utf8'));
    expect(saved.providerApprovals).toHaveLength(1);
  });
});
