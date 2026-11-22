import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const providersModule = fileURLToPath(new URL('./providers.js', import.meta.url));

// Set by beforeEach: an isolated HOME for the child processes, so no
// homedir-derived config source can leak the machine's real state (#2309).
let isolatedHome;

// The user config path is fixed when config-files.js loads, so the calls run in a
// child process pointed at a temporary OPENCODE_CONFIG_DIR; the real user
// config is never touched.
const run = (configDir, body) => {
  const script = `
    import { readDisabledProviders, readProviderOffState, setProviderDisabled } from ${JSON.stringify(providersModule)};
    ${body}
  `;
  // The child inherits this process's env, which on a developer machine
  // exports OPENCODE_CONFIG pointing at the machine's runtime config
  // (e.g. ~/.local/state/opencode/opencode-runtime.jsonc) — that file's
  // providers would leak into the off-state universe (#2309). Scrub the
  // custom-config vars and pin HOME; OPENCODE_CONFIG_DIR is the suite's
  // one config source.
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir, HOME: isolatedHome };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_PATH;
  const result = spawnSync(process.execPath, ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

describe('disabled providers', () => {
  let configDir;
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-disabled-providers-'));
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-disabled-providers-home-'));
  });
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  test('disables and re-enables a provider in the user config, keeping other keys', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ model: 'a/b', disabled_providers: ['groq'] }));

    const afterDisable = run(configDir, `
      setProviderDisabled('openrouter', true, null);
      setProviderDisabled('openrouter', true, null);
      console.log(JSON.stringify(readDisabledProviders(null)));
    `);
    expect(afterDisable).toEqual(['groq', 'openrouter']);

    const afterEnable = run(configDir, `
      setProviderDisabled('groq', false, null);
      setProviderDisabled('openrouter', false, null);
      console.log(JSON.stringify(readDisabledProviders(null)));
    `);
    expect(afterEnable).toEqual([]);
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'));
    expect(written.model).toBe('a/b');
    expect(written.disabled_providers).toBeUndefined();
  });

  test('reports an enabled_providers omission as an allowlist off', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      enabled_providers: ['openai'],
      providers: { openai: {}, anthropic: {} },
    }));

    const state = run(configDir, `
      console.log(JSON.stringify(readProviderOffState(null, ['groq'])));
    `);
    expect(state.enabledProviders).toEqual(['openai']);
    expect(state.reasons).toEqual({ anthropic: 'allowlist', groq: 'allowlist' });
    expect(state.providers.sort()).toEqual(['anthropic', 'groq']);
    // The toggleable list is untouched by the allowlist.
    const listed = run(configDir, `
      console.log(JSON.stringify(readDisabledProviders(null)));
    `);
    expect(listed).toEqual([]);
  });

  test('an empty enabled_providers list is no allowlist', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      enabled_providers: [],
      providers: { anthropic: {} },
    }));

    const state = run(configDir, `
      console.log(JSON.stringify(readProviderOffState(null)));
    `);
    expect(state.enabledProviders).toBeNull();
    expect(state.providers).toEqual([]);
  });

  test('a provider.use deny policy is a policy off and outranks the toggleable list', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      disabled_providers: ['anthropic'],
      policies: [{ action: 'provider.use', resource: 'anthropic', effect: 'deny' }],
    }));

    const state = run(configDir, `
      console.log(JSON.stringify(readProviderOffState(null)));
    `);
    expect(state.reasons).toEqual({ anthropic: 'policy' });
  });

  test('reads the experimental.policies spelling and wildcard resources', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      experimental: { policies: [{ action: 'provider.use', resource: 'gr*', effect: 'deny' }] },
    }));

    const state = run(configDir, `
      console.log(JSON.stringify(readProviderOffState(null, ['groq', 'openai'])));
    `);
    expect(state.reasons).toEqual({ groq: 'policy' });
  });

  test('the user layer decides last: its allow overrides a project wildcard deny', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-policy-project-'));
    try {
      fs.writeFileSync(path.join(projectDir, 'opencode.json'), JSON.stringify({
        policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }],
      }));
      fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
        policies: [{ action: 'provider.use', resource: 'anthropic', effect: 'allow' }],
      }));

      const state = run(configDir, `
        console.log(JSON.stringify(readProviderOffState(${JSON.stringify(projectDir)}, ['anthropic', 'groq'])));
      `);
      expect(state.reasons).toEqual({ groq: 'policy' });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('refuses an invalid provider id', () => {
    expect(() => run(configDir, `setProviderDisabled('Bad Id', true, null); console.log('[]');`)).toThrow('Invalid provider ID');
  });
});
