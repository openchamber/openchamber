import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  upsertProviderConfig,
  validateCustomProviderConfig,
  getProviderSources,
  removeProviderConfig,
} from './providers.js';
import { OPENCODE_CONFIG_DIR } from './shared.js';

let projectDir;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('custom provider config persistence', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('validateCustomProviderConfig rejects invalid endpoint and credentials shape', () => {
    expect(validateCustomProviderConfig('Bad Id', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok).toBe(false);

    expect(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'ftp://api.example.com' },
      models: { m: { name: 'M' } },
    }).error).toContain('http://');

    expect(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: {},
    }).ok).toBe(false);
  });

  test('validateCustomProviderConfig rejects missing credentials', () => {
    expect(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok).toBe(false);

    expect(validateCustomProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }, { hasStoredAuth: true }).ok).toBe(true);

    expect(validateCustomProviderConfig('ok', {
      name: 'X',
      env: ['MY_KEY'],
      options: { baseURL: 'https://api.example.com' },
      models: { m: { name: 'M' } },
    }).ok).toBe(true);
  });

  test('accepts the OpenCode Responses and Anthropic adapter packages', () => {
    for (const npm of ['@ai-sdk/openai', '@ai-sdk/anthropic']) {
      const result = validateCustomProviderConfig('ok', {
        name: 'X',
        npm,
        env: ['MY_KEY'],
        options: { baseURL: 'https://api.example.com/v1' },
        models: { m: { name: 'M' } },
      });
      expect(result.ok).toBe(true);
      expect(result.value.config.package).toBe(`aisdk:${npm}`);
    }
  });

  test('rejects unsupported adapter packages', () => {
    const result = validateCustomProviderConfig('ok', {
      name: 'X',
      npm: '@example/unsupported',
      env: ['MY_KEY'],
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('@ai-sdk/openai');
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

    expect(result.providerId).toBe('campus-llm');
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path.startsWith(projectDir)).toBe(true);

    const written = readJson(result.path);
    expect(written.provider).toBeUndefined();
    expect(written.providers['campus-llm']).toEqual({
      name: 'Campus LLM',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['CAMPUS_KEY'],
      settings: { baseURL: 'https://llm.example.edu/v1' },
      headers: { 'X-Campus': '1' },
      models: {
        'fast-model': { modelID: 'fast-model', name: 'Fast' },
      },
    });

    const sources = getProviderSources('campus-llm', projectDir);
    expect(sources.sources.project.exists).toBe(true);
    expect(sources.sources.project.path).toBe(result.path);
  });

  test('upsertProviderConfig writes, keeps and clears model variants', () => {
    const base = {
      name: 'Campus LLM',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://llm.example.edu/v1' },
      env: ['CAMPUS_KEY'],
    };
    const result = upsertProviderConfig('campus-llm', {
      ...base,
      models: { m: { name: 'M', variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }] } },
    }, projectDir, 'project');
    expect(readJson(result.path).providers['campus-llm'].models.m.variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
    ]);

    upsertProviderConfig('campus-llm', { ...base, models: { m: { name: 'M' } } }, projectDir, 'project');
    expect(readJson(result.path).providers['campus-llm'].models.m.variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
    ]);

    upsertProviderConfig('campus-llm', { ...base, models: { m: { name: 'M', variants: [] } } }, projectDir, 'project');
    expect(readJson(result.path).providers['campus-llm'].models.m).toEqual({ modelID: 'm', name: 'M' });
  });

  test('upsertProviderConfig updates existing entry and clears disabled_providers', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
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
    expect(written.provider).toBeUndefined();
    expect(written.providers['campus-llm'].name).toBe('Campus LLM');
    expect(written.providers['campus-llm'].models).toEqual({ b: { modelID: 'b', name: 'B' } });
    expect(written.disabled_providers).toEqual(['other']);
  });

  test('upsertProviderConfig preserves unmanaged provider and model metadata', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      provider: {
        'campus-llm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Old',
          customProviderField: { owner: 'user' },
          env: ['OLD_KEY'],
          options: {
            baseURL: 'https://old.example.edu/v1',
            headers: { 'X-Old': '1' },
            timeout: 45_000,
          },
          models: {
            retained: {
              name: 'Old retained name',
              reasoning: true,
              attachment: true,
              tool_call: true,
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
              limit: { context: 1_050_000, input: 922_000, output: 128_000 },
              options: { instructions: 'Keep this instruction' },
              variants: {
                low: { reasoningEffort: 'low' },
                high: { reasoningEffort: 'high' },
              },
              customModelField: { source: 'manual' },
            },
            removed: {
              name: 'Remove me',
              reasoning: true,
            },
          },
        },
      },
    });

    upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      options: { baseURL: 'https://new.example.edu/v1' },
      models: {
        retained: { name: 'Retained model' },
        added: { name: 'Added model' },
      },
    }, projectDir, 'project', { hasStoredAuth: true });

    // A legacy `provider` entry is rewritten in place into `providers` in v2
    // shape: `npm` -> `package`, `options` -> `settings`, `tool_call`/
    // `modalities` -> `capabilities`, variants map -> variants array. Fields v2
    // accepts but ignores (`reasoning`, `attachment`) are dropped.
    const config = readJson(configPath);
    expect(config.provider).toBeUndefined();
    expect(config.providers['campus-llm']).toEqual({
      name: 'Campus LLM',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: {
        baseURL: 'https://new.example.edu/v1',
        timeout: 45_000,
      },
      models: {
        retained: {
          modelID: 'retained',
          name: 'Retained model',
          settings: { instructions: 'Keep this instruction' },
          capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'] },
          variants: [
            { id: 'low', settings: { reasoningEffort: 'low' } },
            { id: 'high', settings: { reasoningEffort: 'high' } },
          ],
          limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        },
        added: { modelID: 'added', name: 'Added model' },
      },
    });
  });

  test('renaming a provider keeps canonical and model compatibility', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      providers: {
        'openai-proxy': {
          canonical: 'openai',
          name: 'Old name',
          package: 'aisdk:@ai-sdk/openai-compatible',
          env: ['PROXY_KEY'],
          settings: { baseURL: 'https://proxy.example.com/v1' },
          models: {
            'gpt-5': {
              modelID: 'gpt-5',
              name: 'GPT-5',
              compatibility: { reasoningField: 'reasoning_content', requireReasoning: true, maxTokensField: 'max_tokens' },
            },
          },
        },
      },
    });

    upsertProviderConfig('openai-proxy', {
      name: 'New name',
      env: ['PROXY_KEY'],
      settings: { baseURL: 'https://proxy.example.com/v1' },
      models: { 'gpt-5': { name: 'GPT-5' } },
    }, projectDir, 'project');

    expect(readJson(configPath).providers['openai-proxy']).toEqual({
      canonical: 'openai',
      name: 'New name',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['PROXY_KEY'],
      settings: { baseURL: 'https://proxy.example.com/v1' },
      models: {
        'gpt-5': {
          modelID: 'gpt-5',
          name: 'GPT-5',
          compatibility: { reasoningField: 'reasoning_content', requireReasoning: true, maxTokensField: 'max_tokens' },
        },
      },
    });
  });

  test('accepts a native v2 payload and keeps the entry in providers', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      providers: {
        native: {
          name: 'Native provider',
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: 'https://old.example.com/v1', timeout: 30_000 },
          models: { model: { modelID: 'model', name: 'Old model' } },
        },
      },
    });

    upsertProviderConfig('native', {
      name: 'Updated provider',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://new.example.com/v1' },
      models: { model: { name: 'Updated model' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    const written = readJson(configPath);
    expect(written.provider).toBeUndefined();
    expect(written.providers.native).toEqual({
      name: 'Updated provider',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://new.example.com/v1', timeout: 30_000 },
      models: { model: { modelID: 'model', name: 'Updated model' } },
    });
  });

  test('rewriting one legacy provider entry leaves the other legacy entries alone', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      provider: {
        legacy: { npm: '@ai-sdk/openai-compatible', name: 'Legacy provider', options: { baseURL: 'https://old.example.com/v1' }, models: { model: { name: 'Old model' } } },
        untouched: { npm: '@ai-sdk/openai-compatible', name: 'Untouched', options: { baseURL: 'https://other.example.com/v1' }, models: { model: { name: 'Other model' } } },
      },
    });

    upsertProviderConfig('legacy', {
      name: 'Updated provider',
      options: { baseURL: 'https://new.example.com/v1' },
      models: { model: { name: 'Updated model' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    const written = readJson(configPath);
    expect(written.provider).toEqual({
      untouched: { npm: '@ai-sdk/openai-compatible', name: 'Untouched', options: { baseURL: 'https://other.example.com/v1' }, models: { model: { name: 'Other model' } } },
    });
    expect(written.providers.legacy.name).toBe('Updated provider');
  });

  test('upsert then remove restores absence', () => {
    upsertProviderConfig('temp-provider', {
      name: 'Temp',
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
      env: ['TEMP_KEY'],
    }, projectDir, 'project');

    expect(getProviderSources('temp-provider', projectDir).sources.project.exists).toBe(true);
    expect(removeProviderConfig('temp-provider', projectDir, 'project')).toBe(true);
    expect(getProviderSources('temp-provider', projectDir).sources.project.exists).toBe(false);
  });

  test('failed validation does not write config', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    expect(() => upsertProviderConfig('ok', {
      name: 'X',
      options: { baseURL: 'not-a-url' },
      models: { m: { name: 'M' } },
      env: ['X'],
    }, projectDir, 'project')).toThrow(/Base URL/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test('upsert with hasStoredAuth allows config without env', () => {
    const result = upsertProviderConfig('keyed-provider', {
      name: 'Keyed',
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    expect(result.providerId).toBe('keyed-provider');
    expect(result.config.env).toEqual(undefined);
  });

  test('project-scope edit updates project layer without creating a user entry', () => {
    const providerId = `proj-scope-${Date.now()}`;
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');

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
    expect(written.providers[providerId]).toEqual({
      name: 'Project Scoped Updated',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://project.example.com/v2' },
      headers: { 'X-Project': '1' },
      models: { m: { modelID: 'm', name: 'M2' } },
    });

    const sources = getProviderSources(providerId, projectDir);
    expect(sources.sources.project.exists).toBe(true);
    expect(sources.sources.user.exists).toBe(false);
    expect(sources.sources.custom.exists).toBe(false);

    for (const userPath of [
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'config.json'),
    ]) {
      if (!fs.existsSync(userPath)) continue;
      const userConfig = readJson(userPath);
      expect(userConfig.provider?.[providerId]).toBeUndefined();
      expect(userConfig.providers?.[providerId]).toBeUndefined();
    }
  });

  test('getProviderSources returns the stored entry from a JSONC config, v2 shape, without the key', () => {
    const configPath = path.join(projectDir, '.opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `{
  // v1 spelling, still decoded by OpenCode 2
  "provider": {
    "stored-llm": {
      "name": "Stored",
      "npm": "@ai-sdk/openai-compatible",
      "env": ["STORED_KEY"],
      "options": { "baseURL": "https://stored.example.com/v1", "apiKey": "sk-secret", "timeout": 5 },
      "models": { "m": { "name": "M", "variants": { "high": { "reasoningEffort": "high" } } } },
    },
  },
}`, 'utf8');

    const { config } = getProviderSources('stored-llm', projectDir);
    expect(config).toEqual({
      name: 'Stored',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['STORED_KEY'],
      settings: { baseURL: 'https://stored.example.com/v1', timeout: 5 },
      models: { m: { name: 'M', variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] } },
    });
    expect(getProviderSources('missing-llm', projectDir).config).toBeNull();
  });

  test('saving the stored entry back keeps env, settings and model fields it does not edit', () => {
    const providerId = 'keep-llm';
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      providers: {
        [providerId]: {
          name: 'Keep',
          package: 'aisdk:@ai-sdk/openai-compatible',
          env: ['KEEP_KEY'],
          settings: { baseURL: 'https://keep.example.com/v1', timeout: 5 },
          body: { store: false },
          models: { m: { modelID: 'm', name: 'M', limit: { context: 1000 } } },
        },
      },
    });

    const { config } = getProviderSources(providerId, projectDir);
    upsertProviderConfig(providerId, {
      name: config.name,
      package: config.package,
      env: config.env,
      settings: { baseURL: config.settings.baseURL },
      models: { m: { name: 'M renamed' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    expect(readJson(configPath).providers[providerId]).toEqual({
      name: 'Keep',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['KEEP_KEY'],
      settings: { baseURL: 'https://keep.example.com/v1', timeout: 5 },
      body: { store: false },
      models: { m: { modelID: 'm', name: 'M renamed', limit: { context: 1000 } } },
    });
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
      expect(written.providers[providerId].name).toBe('Custom Scoped Updated');
      expect(written.providers[providerId].settings.baseURL).toBe('https://custom.example.com/v2');

      const sources = getProviderSources(providerId, projectDir);
      expect(sources.sources.custom.exists).toBe(true);
      expect(sources.sources.user.exists).toBe(false);
      expect(sources.sources.project.exists).toBe(false);

      for (const userPath of [
        path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
        path.join(OPENCODE_CONFIG_DIR, 'config.json'),
      ]) {
        if (!fs.existsSync(userPath)) continue;
        const userConfig = readJson(userPath);
        expect(userConfig.provider?.[providerId]).toBeUndefined();
        expect(userConfig.providers?.[providerId]).toBeUndefined();
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
