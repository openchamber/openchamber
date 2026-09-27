import './opencodeConfigTestHome';
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
import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';

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

  test('accepts supported protocol adapters and rejects arbitrary npm packages', () => {
    for (const npm of ['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']) {
      const result = validateCustomProviderConfig('ok', {
        name: 'X',
        npm,
        env: ['MY_KEY'],
        options: { baseURL: 'https://api.example.com/v1' },
        models: { m: { name: 'M' } },
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value.config.package, `aisdk:${npm}`);
    }

    const unsupported = validateCustomProviderConfig('ok', {
      name: 'X',
      npm: 'untrusted-provider-package',
      env: ['MY_KEY'],
      options: { baseURL: 'https://api.example.com/v1' },
      models: { m: { name: 'M' } },
    });
    assert.equal(unsupported.ok, false);
    assert.equal(
      unsupported.error,
      'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, or @ai-sdk/anthropic',
    );
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
    assert.equal(written.provider, undefined);
    assert.deepEqual(written.providers['campus-llm'], {
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
    assert.equal(sources.project.exists, true);
    assert.equal(sources.project.path, result.path);
  });

  test('round-trips non-default protocol adapters through project config', () => {
    for (const [providerId, npm] of [
      ['responses-provider', '@ai-sdk/openai'],
      ['anthropic-provider', '@ai-sdk/anthropic'],
    ]) {
      const result = upsertProviderConfig(providerId, {
        name: providerId,
        npm,
        env: ['PROVIDER_KEY'],
        options: { baseURL: 'https://api.example.com/v1' },
        models: { model: { name: 'Model' } },
      }, projectDir, 'project');
      assert.equal(result.config.package, `aisdk:${npm}`);
      assert.equal(readJson(result.path).providers[providerId].package, `aisdk:${npm}`);
    }
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
    assert.equal(written.provider, undefined);
    assert.equal(written.providers['campus-llm'].name, 'Campus LLM');
    assert.deepEqual(written.providers['campus-llm'].models, { b: { modelID: 'b', name: 'B' } });
    assert.deepEqual(written.disabled_providers, ['other']);
  });

  test('upsertProviderConfig preserves unmanaged provider and model metadata', () => {
    const configPath = path.join(projectDir, 'opencode.json');
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
    assert.equal(config.provider, undefined);
    assert.deepEqual(config.providers['campus-llm'], {
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
    const compatibility = { reasoningField: 'reasoning_content', requireReasoning: true, maxTokensField: 'max_tokens' };
    writeJson(configPath, {
      providers: {
        'openai-proxy': {
          canonical: 'openai',
          name: 'Old name',
          package: 'aisdk:@ai-sdk/openai-compatible',
          env: ['PROXY_KEY'],
          settings: { baseURL: 'https://proxy.example.com/v1' },
          models: { 'gpt-5': { modelID: 'gpt-5', name: 'GPT-5', compatibility } },
        },
      },
    });

    upsertProviderConfig('openai-proxy', {
      name: 'New name',
      env: ['PROXY_KEY'],
      settings: { baseURL: 'https://proxy.example.com/v1' },
      models: { 'gpt-5': { name: 'GPT-5' } },
    }, projectDir, 'project');

    assert.deepEqual(readJson(configPath).providers['openai-proxy'], {
      canonical: 'openai',
      name: 'New name',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['PROXY_KEY'],
      settings: { baseURL: 'https://proxy.example.com/v1' },
      models: { 'gpt-5': { modelID: 'gpt-5', name: 'GPT-5', compatibility } },
    });
  });

  test('upsertProviderConfig preserves metadata while migrating the legacy providers alias', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    writeJson(configPath, {
      providers: {
        legacy: {
          name: 'Legacy provider',
          options: { baseURL: 'https://old.example.com/v1', timeout: 30_000 },
          models: { model: { name: 'Old model', reasoning: true } },
        },
      },
    });

    upsertProviderConfig('legacy', {
      name: 'Updated provider',
      options: { baseURL: 'https://new.example.com/v1' },
      models: { model: { name: 'Updated model' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    const written = readJson(configPath);
    assert.equal(written.provider, undefined);
    assert.deepEqual(written.providers.legacy, {
      name: 'Updated provider',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://new.example.com/v1', timeout: 30_000 },
      models: { model: { modelID: 'model', name: 'Updated model' } },
    });
  });

  test('migrating one legacy providers entry keeps the other legacy entries', () => {
    const configPath = path.join(projectDir, 'opencode.json');
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
    assert.deepEqual(written.provider, {
      untouched: { npm: '@ai-sdk/openai-compatible', name: 'Untouched', options: { baseURL: 'https://other.example.com/v1' }, models: { model: { name: 'Other model' } } },
    });
    assert.equal(written.providers.legacy.name, 'Updated provider');
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
    assert.deepEqual(written.providers[providerId], {
      name: 'Project Scoped Updated',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://project.example.com/v2' },
      headers: { 'X-Project': '1' },
      models: { m: { modelID: 'm', name: 'M2' } },
    });

    const sources = getProviderSources(providerId, projectDir);
    assert.equal(sources.project.exists, true);
    assert.equal(sources.user.exists, false);
    assert.equal(sources.custom.exists, false);

    for (const userPath of [
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'config.json'),
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
      assert.equal(written.providers[providerId].name, 'Custom Scoped Updated');
      assert.equal(written.providers[providerId].settings.baseURL, 'https://custom.example.com/v2');

      const sources = getProviderSources(providerId, projectDir);
      assert.equal(sources.custom.exists, true);
      assert.equal(sources.user.exists, false);
      assert.equal(sources.project.exists, false);

      for (const userPath of [
        path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
        path.join(OPENCODE_CONFIG_DIR, 'config.json'),
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
