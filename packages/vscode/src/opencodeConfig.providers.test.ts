import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getProviderSources,
  removeProviderConfig,
  upsertProviderConfig,
  validateCustomProviderConfig,
} from './opencodeConfig';

let projectDir: string;

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('custom provider config persistence (VS Code parity)', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-provider-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('validateCustomProviderConfig rejects invalid endpoint and credentials shape', () => {
    assert.equal(validateCustomProviderConfig('Bad Id', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok, false);

    const ftp = validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'ftp://api.example.com' },
      models: { m: { name: 'M' } },
    });
    assert.equal(ftp.ok, false);
    assert.match(ftp.error ?? '', /http:\/\//);

    assert.equal(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: {},
    }).ok, false);
  });

  test('validateCustomProviderConfig rejects missing credentials', () => {
    assert.equal(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok, false);

    assert.equal(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }, { hasStoredAuth: true }).ok, true);

    assert.equal(validateCustomProviderConfig('ok', {
      name: 'X',
      env: ['MY_KEY'],
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok, true);
  });

  test('upsertProviderConfig writes and round-trips project config', () => {
    const result = upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://llm.example.edu/v1',
        headers: { 'X-Campus': '1' },
      },
      models: {
        'fast-model': { name: 'Fast' },
      },
      env: ['CAMPUS_KEY'],
    }, projectDir, 'project');

    assert.equal(result.providerId, 'campus-llm');
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(result.path.startsWith(projectDir), true);

    const written = readJson(result.path);
    assert.deepEqual(written.provider['campus-llm'], {
      npm: '@ai-sdk/openai-compatible',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: {
        baseURL: 'https://llm.example.edu/v1',
        headers: { 'X-Campus': '1' },
      },
      models: {
        'fast-model': { name: 'Fast' },
      },
    });

    const sources = getProviderSources('campus-llm', projectDir);
    assert.equal(sources.project.exists, true);
    assert.equal(sources.project.path, result.path);
  });

  test('upsertProviderConfig updates existing entry and clears disabled_providers', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    writeJson(configPath, {
      provider: {
        'campus-llm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Old',
          options: { baseURL: 'https://old.example.edu/v1' },
          models: { a: { name: 'A' } },
        },
      },
      disabled_providers: ['campus-llm', 'other'],
    });

    upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: { b: { name: 'B' } },
      env: ['CAMPUS_KEY'],
    }, projectDir, 'project');

    const written = readJson(configPath);
    assert.equal(written.provider['campus-llm'].name, 'Campus LLM');
    assert.deepEqual(written.provider['campus-llm'].models, { b: { name: 'B' } });
    assert.deepEqual(written.disabled_providers, ['other']);
  });

  test('upsert then remove restores absence', () => {
    upsertProviderConfig('temp-provider', {
      name: 'Temp',
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
      env: ['TEMP_KEY'],
    }, projectDir, 'project');

    assert.equal(getProviderSources('temp-provider', projectDir).project.exists, true);
    assert.equal(removeProviderConfig('temp-provider', projectDir, 'project'), true);
    assert.equal(getProviderSources('temp-provider', projectDir).project.exists, false);
  });

  test('failed validation does not write config', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    assert.throws(
      () => upsertProviderConfig('ok', {
        name: 'X',
        options: { baseURL: 'not-a-url' },
        models: { m: { name: 'M' } },
        env: ['X'],
      }, projectDir, 'project'),
      /Base URL/,
    );
    assert.equal(fs.existsSync(configPath), false);
  });

  test('upsert with hasStoredAuth allows config without env', () => {
    const result = upsertProviderConfig('keyed-provider', {
      name: 'Keyed',
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    assert.equal(result.providerId, 'keyed-provider');
    assert.equal(result.config.env, undefined);
  });

  test('project-scope edit updates project layer without creating a user entry', () => {
    const providerId = `proj-scope-${Date.now()}`;
    const configPath = path.join(projectDir, 'opencode.json');

    upsertProviderConfig(providerId, {
      name: 'Project Scoped',
      options: { baseURL: 'https://project.example.com/v1' },
      models: { m: { name: 'M' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    upsertProviderConfig(providerId, {
      name: 'Project Scoped Updated',
      options: { baseURL: 'https://project.example.com/v2', headers: { 'X-Project': '1' } },
      models: { m: { name: 'M2' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    const written = readJson(configPath);
    assert.deepEqual(written.provider[providerId], {
      npm: '@ai-sdk/openai-compatible',
      name: 'Project Scoped Updated',
      options: {
        baseURL: 'https://project.example.com/v2',
        headers: { 'X-Project': '1' },
      },
      models: { m: { name: 'M2' } },
    });

    const sources = getProviderSources(providerId, projectDir);
    assert.equal(sources.project.exists, true);
    assert.equal(sources.user.exists, false);
    assert.equal(sources.custom.exists, false);

    for (const userPath of [
      path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
      path.join(os.homedir(), '.config', 'opencode', 'config.json'),
    ]) {
      if (!fs.existsSync(userPath)) continue;
      const userConfig = readJson(userPath);
      assert.equal(userConfig.provider?.[providerId], undefined);
      assert.equal(userConfig.providers?.[providerId], undefined);
    }
  });

  test('custom-scope edit updates custom layer without creating a user entry', () => {
    const providerId = `custom-scope-${Date.now()}`;
    const customPath = path.join(projectDir, 'custom-opencode.json');
    const previousEnv = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = customPath;

    try {
      upsertProviderConfig(providerId, {
        name: 'Custom Scoped',
        options: { baseURL: 'https://custom.example.com/v1' },
        models: { m: { name: 'M' } },
      }, projectDir, 'custom', { hasStoredAuth: true });

      upsertProviderConfig(providerId, {
        name: 'Custom Scoped Updated',
        options: { baseURL: 'https://custom.example.com/v2' },
        models: { n: { name: 'N' } },
      }, projectDir, 'custom', { hasStoredAuth: true });

      const written = readJson(customPath);
      assert.equal(written.provider[providerId].name, 'Custom Scoped Updated');
      assert.equal(written.provider[providerId].options.baseURL, 'https://custom.example.com/v2');

      const sources = getProviderSources(providerId, projectDir);
      assert.equal(sources.custom.exists, true);
      assert.equal(sources.user.exists, false);
      assert.equal(sources.project.exists, false);

      for (const userPath of [
        path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
        path.join(os.homedir(), '.config', 'opencode', 'config.json'),
      ]) {
        if (!fs.existsSync(userPath)) continue;
        const userConfig = readJson(userPath);
        assert.equal(userConfig.provider?.[providerId], undefined);
        assert.equal(userConfig.providers?.[providerId], undefined);
      }
    } finally {
      if (previousEnv === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = previousEnv;
      }
    }
  });
});
