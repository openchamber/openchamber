import { describe, expect, it } from 'vitest';

import { INJECTED_ENV_KEY, assignInjectedEnv, injectedEnvKeys } from './injected-env.js';

describe('assignInjectedEnv', () => {
  it('sets the values and records their names', () => {
    const env = { PATH: '/usr/bin' };

    expect(assignInjectedEnv(env, { OPENCHAMBER_RUNTIME: 'desktop', OPENCHAMBER_DESKTOP_NOTIFY: 'true' })).toBe(env);

    expect(env).toEqual({
      PATH: '/usr/bin',
      OPENCHAMBER_RUNTIME: 'desktop',
      OPENCHAMBER_DESKTOP_NOTIFY: 'true',
      [INJECTED_ENV_KEY]: 'OPENCHAMBER_RUNTIME,OPENCHAMBER_DESKTOP_NOTIFY',
    });
    expect(injectedEnvKeys(env)).toEqual(new Set(['OPENCHAMBER_RUNTIME', 'OPENCHAMBER_DESKTOP_NOTIFY', INJECTED_ENV_KEY]));
  });

  it('leaves a value the shell already had as the user\'s', () => {
    const env = { OPENCODE_PASSWORD: 'theirs', OPENCHAMBER_SKIP_API_COMPRESSION: 'false' };

    assignInjectedEnv(env, {
      OPENCODE_PASSWORD: 'theirs',
      OPENCODE_SERVER_PASSWORD: 'theirs',
      OPENCHAMBER_SKIP_API_COMPRESSION: env.OPENCHAMBER_SKIP_API_COMPRESSION || 'true',
    });

    expect(env.OPENCHAMBER_SKIP_API_COMPRESSION).toBe('false');
    expect(injectedEnvKeys(env)).toEqual(new Set(['OPENCODE_SERVER_PASSWORD', INJECTED_ENV_KEY]));
  });

  it('adds to a record inherited from the parent process', () => {
    const env = assignInjectedEnv({}, { OPENCHAMBER_RUNTIME: 'desktop' });
    const child = assignInjectedEnv({ ...env }, { OPENCODE_CONFIG: '/tmp/opencode.json', OPENCHAMBER_RUNTIME: 'desktop' });

    expect(child[INJECTED_ENV_KEY]).toBe('OPENCHAMBER_RUNTIME,OPENCODE_CONFIG');
    expect(env[INJECTED_ENV_KEY]).toBe('OPENCHAMBER_RUNTIME');
  });

  it('skips undefined values and writes no record when nothing changed', () => {
    const env = { OPENCHAMBER_HOST: '0.0.0.0' };

    assignInjectedEnv(env, { OPENCHAMBER_UI_PASSWORD: undefined, OPENCHAMBER_HOST: '0.0.0.0' });

    expect(env).toEqual({ OPENCHAMBER_HOST: '0.0.0.0' });
    expect(injectedEnvKeys(env).size).toBe(0);
  });
});

describe('injectedEnvKeys', () => {
  it('ignores a malformed record', () => {
    expect(injectedEnvKeys({ [INJECTED_ENV_KEY]: '' }).size).toBe(0);
    expect(injectedEnvKeys({ [INJECTED_ENV_KEY]: ',,' })).toEqual(new Set([INJECTED_ENV_KEY]));
  });
});
