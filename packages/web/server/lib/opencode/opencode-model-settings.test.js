import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { fileURLToPath } from 'url';
import { registerOpenCodeRoutes } from './routes.js';

// Oracle: OpenCode's config contract for `providers.<id>.models.<id>`
// (hidden, defaultVariant, lockVariant), and its rule that a `providers` entry
// replaces a legacy `provider` entry of the same id whole.

const providersModule = fileURLToPath(new URL('./providers.js', import.meta.url));
const routesModule = fileURLToPath(new URL('./routes.js', import.meta.url));
let isolatedHome;
let configDir;

// The user config path is fixed when shared.js loads, so each call runs in a
// child pointed at a temporary OPENCODE_CONFIG_DIR (as providers-disabled.test.js does).
const run = (body, cwd) => {
  const script = `
    import { readModelSettings, writeModelSettings } from ${JSON.stringify(providersModule)};
    ${body}
  `;
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir, HOME: isolatedHome };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_PATH;
  const result = spawnSync(process.execPath, ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], { env, encoding: 'utf8', cwd });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};
const userFile = () => path.join(configDir, 'opencode.json');
const stored = () => JSON.parse(fs.readFileSync(userFile(), 'utf8'));

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-model-settings-'));
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-model-settings-home-'));
});
afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe('OpenCode model settings in the config files', () => {
  it('edits a legacy provider entry in place and keeps the rest of the definition', () => {
    fs.writeFileSync(userFile(), JSON.stringify({
      provider: { mock: { options: { baseURL: 'http://x/v1' }, models: { ok: { name: 'OK' }, other: { name: 'Other' } } } },
    }));
    const state = run(`console.log(JSON.stringify(writeModelSettings('mock', 'ok', { hidden: true, defaultVariant: 'high', lockVariant: true }, null)));`);
    expect(state.models['mock/ok']).toEqual({ hidden: true, defaultVariant: 'high', lockVariant: true });
    expect(stored()).toEqual({
      provider: {
        mock: {
          options: { baseURL: 'http://x/v1' },
          models: { ok: { name: 'OK', hidden: true, defaultVariant: 'high', lockVariant: true }, other: { name: 'Other' } },
        },
      },
    });
    run(`writeModelSettings('mock', 'ok', { hidden: null, defaultVariant: null, lockVariant: null }, null); console.log('{}');`);
    expect(stored().provider.mock.models.ok).toEqual({ name: 'OK' });
  });

  it('creates a providers entry only when none exists, and removes it again when emptied', () => {
    fs.writeFileSync(userFile(), JSON.stringify({ model: 'a/b' }));
    run(`writeModelSettings('openai', 'gpt', { hidden: true }, null); console.log('{}');`);
    expect(stored()).toEqual({ model: 'a/b', providers: { openai: { models: { gpt: { hidden: true } } } } });
    const state = run(`console.log(JSON.stringify(writeModelSettings('openai', 'gpt', { hidden: null }, null)));`);
    expect(stored()).toEqual({ model: 'a/b' });
    expect(state.models).toEqual({});
  });

  it('reads the providers spelling over the legacy one in a file, and a project file over the user file', () => {
    fs.writeFileSync(userFile(), JSON.stringify({
      provider: { mock: { models: { ok: { hidden: true }, legacyOnly: { defaultVariant: 'low' } } } },
      providers: { mock: { models: { ok: { defaultVariant: 'high' } } }, other: { models: { m: { lockVariant: false, defaultVariant: 'max' } } } },
    }));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-model-settings-project-'));
    try {
      fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ providers: { other: { models: { m: { lockVariant: true } } } } }));
      const state = run(`console.log(JSON.stringify(readModelSettings(${JSON.stringify(project)})));`);
      expect(state.models).toEqual({
        'mock/ok': { defaultVariant: 'high' },
        'other/m': { defaultVariant: 'max', lockVariant: true },
      });
      expect(state.path).toBe(userFile());
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('the model settings route', () => {
  // No app-wide JSON parser: the server parses bodies only for listed path
  // prefixes (core-routes.js), so the route must parse its own. A global parser
  // here once hid a route that received no body at all.
  const createApp = () => {
    const app = express();
    registerOpenCodeRoutes(app, { resolveProjectDirectory: vi.fn(async () => ({ directory: null })) });
    return app;
  };

  it('saves a change sent over HTTP and reads it back, with no app-wide body parser', () => {
    fs.writeFileSync(userFile(), JSON.stringify({ provider: { mock: { options: { baseURL: 'http://x/v1' }, models: { ok: { name: 'OK' } } } } }));
    const script = `
      import express from 'express';
      import { registerOpenCodeRoutes } from ${JSON.stringify(routesModule)};
      const app = express();
      registerOpenCodeRoutes(app, { resolveProjectDirectory: async () => ({ directory: null }) });
      const server = app.listen(0, '127.0.0.1', async () => {
        const base = 'http://127.0.0.1:' + server.address().port + '/api/config/opencode-model-settings';
        const put = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerID: 'mock', modelID: 'ok', settings: { hidden: true, defaultVariant: 'high' } }) });
        const get = await fetch(base);
        console.log(JSON.stringify({ put: put.status, putBody: await put.json(), get: get.status, getBody: await get.json() }));
        process.exit(0);
      });
    `;
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir, HOME: isolatedHome };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_PATH;
    delete env.OPENCHAMBER_ENTERPRISE_MODE;
    const result = spawnSync(process.execPath, ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], { env, encoding: 'utf8', cwd: path.dirname(routesModule), timeout: 60_000 });
    if (result.status !== 0) throw new Error(result.stderr);
    const answer = JSON.parse(result.stdout.trim().split('\n').pop());
    expect([answer.put, answer.get]).toEqual([200, 200]);
    expect(answer.putBody.models['mock/ok']).toEqual({ hidden: true, defaultVariant: 'high' });
    expect(answer.getBody.models['mock/ok']).toEqual({ hidden: true, defaultVariant: 'high' });
    expect(stored().provider.mock).toEqual({ options: { baseURL: 'http://x/v1' }, models: { ok: { name: 'OK', hidden: true, defaultVariant: 'high' } } });
  });

  it('refuses a write in enterprise mode and an unknown or malformed setting', async () => {
    const agent = request(createApp());
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const refused = await agent.put('/api/config/opencode-model-settings').send({ providerID: 'p', modelID: 'm', settings: { hidden: true } });
      expect([refused.status, refused.body.code]).toEqual([403, 'enterprise_mode']);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
    const cases = [
      { providerID: 'p', settings: { hidden: true } },
      { providerID: 'p', modelID: 'm', settings: { disabled: true } },
      { providerID: 'p', modelID: 'm', settings: { hidden: 'yes' } },
      { providerID: 'p', modelID: 'm', settings: { defaultVariant: 'two words' } },
    ];
    for (const body of cases) expect((await agent.put('/api/config/opencode-model-settings').send(body)).status).toBe(400);
    // The refusal names the field, so the route did read the body.
    const named = await agent.put('/api/config/opencode-model-settings').send({ providerID: 'p', modelID: 'm', settings: { hidden: 'yes' } });
    expect(named.body.error).toMatch(/^settings\.hidden: /);
  });
});
