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
      expect(result.value.config.npm).toBe(npm);
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
    expect(written.provider['campus-llm']).toEqual({
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
    expect(sources.sources.project.exists).toBe(true);
    expect(sources.sources.project.path).toBe(result.path);
    expect(sources.providerBlock).toEqual({
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
    expect(written.provider['campus-llm'].name).toBe('Campus LLM');
    expect(written.provider['campus-llm'].models).toEqual({ b: { name: 'B' } });
    expect(written.disabled_providers).toEqual(['other']);
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

    const written = readJson(configPath).provider['campus-llm'];
    expect(written).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Campus LLM',
      customProviderField: { owner: 'user' },
      options: {
        baseURL: 'https://new.example.edu/v1',
        timeout: 45_000,
      },
      models: {
        retained: {
          name: 'Retained model',
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
        added: { name: 'Added model' },
      },
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
    expect(written.providers).toBeUndefined();
    expect(written.provider.legacy).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Updated provider',
      options: { baseURL: 'https://new.example.com/v1', timeout: 30_000 },
      models: { model: { name: 'Updated model', reasoning: true } },
    });
  });

  test('migrating one legacy providers entry keeps the other legacy entries', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    writeJson(configPath, {
      providers: {
        legacy: { name: 'Legacy provider', options: { baseURL: 'https://old.example.com/v1' }, models: { model: { name: 'Old model' } } },
        untouched: { name: 'Untouched', options: { baseURL: 'https://other.example.com/v1' }, models: { model: { name: 'Other model' } } },
      },
    });

    upsertProviderConfig('legacy', {
      name: 'Updated provider',
      options: { baseURL: 'https://new.example.com/v1' },
      models: { model: { name: 'Updated model' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    const written = readJson(configPath);
    expect(written.providers).toEqual({
      untouched: { name: 'Untouched', options: { baseURL: 'https://other.example.com/v1' }, models: { model: { name: 'Other model' } } },
    });
    expect(written.provider.legacy.name).toBe('Updated provider');
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

  test('getProviderSources returns the winning authored block with custom > project precedence', () => {
    writeJson(path.join(projectDir, 'opencode.json'), {
      provider: {
        'campus-llm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Project layer',
          options: { baseURL: 'https://project.example.com/v1' },
          models: { m: { name: 'M' } },
        },
      },
    });

    expect(getProviderSources('campus-llm', projectDir).providerBlock.name).toBe('Project layer');

    const customPath = path.join(projectDir, 'custom-opencode.json');
    const previousEnv = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = customPath;
    try {
      // Legacy `providers` alias must be picked up like the primary key.
      writeJson(customPath, {
        providers: {
          'campus-llm': {
            npm: '@ai-sdk/openai-compatible',
            name: 'Custom layer',
            options: { baseURL: 'https://custom.example.com/v1' },
            models: { m: { name: 'M' } },
          },
        },
      });

      const sources = getProviderSources('campus-llm', projectDir);
      expect(sources.providerBlock.name).toBe('Custom layer');
      expect(sources.sources.custom.exists).toBe(true);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = previousEnv;
      }
    }
  });

  test('getProviderSources omits providerBlock for catalog-only providers', () => {
    expect(getProviderSources('never-authored', projectDir).providerBlock).toBeNull();
  });

  test('failed validation does not write config', () => {
    const configPath = path.join(projectDir, 'opencode.json');
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
    expect(written.provider[providerId]).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Project Scoped Updated',
      options: {
        baseURL: 'https://project.example.com/v2',
        headers: { 'X-Project': '1' },
      },
      models: { m: { name: 'M2' } },
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
      expect(written.provider[providerId].name).toBe('Custom Scoped Updated');
      expect(written.provider[providerId].options.baseURL).toBe('https://custom.example.com/v2');

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

  test('validateCustomProviderConfig rejects malformed model capabilities', () => {
    const base = { name: 'X', options: { baseURL: 'https://api.example.com' } };
    const invalid = [
      { m: { name: 'M', attachment: 'true' } },
      { m: { name: 'M', attachment: 1 } },
      { m: { name: 'M', limit: { context: -1 } } },
      { m: { name: 'M', limit: { context: 1.5 } } },
      { m: { name: 'M', modalities: { input: 'text' } } },
      { m: { name: 'M', modalities: { input: ['', '  '] } } },
      { m: { name: 'M', variants: { '': {} } } },
      { m: { name: 'M', variants: { low: 'nope' } } },
    ];
    for (const models of invalid) {
      expect(validateCustomProviderConfig('ok', { ...base, models }, { hasStoredAuth: true }).ok).toBe(false);
    }
  });

  test('manageModelCapabilities does not clear capabilities when a malformed attachment is sent', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    writeJson(configPath, {
      provider: {
        'campus-llm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Old',
          options: { baseURL: 'https://old.example.edu/v1' },
          models: {
            kept: { name: 'Kept', attachment: true },
          },
        },
      },
    });

    expect(() => upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      options: { baseURL: 'https://new.example.edu/v1' },
      models: { kept: { name: 'Kept', attachment: 'true' } },
    }, projectDir, 'project', { hasStoredAuth: true, manageModelCapabilities: true })).toThrow();

    expect(readJson(configPath).provider['campus-llm'].models.kept).toEqual({
      name: 'Kept',
      attachment: true,
    });
  });

  test('upsertProviderConfig normalizes and persists model capabilities', () => {
    const result = upsertProviderConfig('cap-llm', {
      name: 'Cap LLM',
      options: { baseURL: 'https://cap.example.edu/v1' },
      models: {
        m: {
          name: 'M',
          attachment: true,
          modalities: { input: ['text', ' image '], output: ['text'] },
          limit: { context: 128000, output: 4096 },
          variants: { low: { reasoningEffort: 'low' } },
        },
      },
      env: ['CAP_KEY'],
    }, projectDir, 'project');

    expect(readJson(result.path).provider['cap-llm'].models.m).toEqual({
      name: 'M',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000, output: 4096 },
      variants: { low: { reasoningEffort: 'low' } },
    });
  });

  test('manageModelCapabilities clears removed capability fields but keeps unmanaged metadata', () => {
    const configPath = path.join(projectDir, 'opencode.json');
    writeJson(configPath, {
      provider: {
        'campus-llm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Old',
          options: { baseURL: 'https://old.example.edu/v1' },
          models: {
            kept: {
              name: 'Kept',
              attachment: true,
              reasoning: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 1000, output: 200 },
              variants: { low: { reasoningEffort: 'low' } },
              options: { instructions: 'stay' },
            },
          },
        },
      },
    });

    // The capability-aware form resubmits the model with only the fields still set.
    upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      options: { baseURL: 'https://new.example.edu/v1' },
      models: { kept: { name: 'Kept' } },
    }, projectDir, 'project', { hasStoredAuth: true, manageModelCapabilities: true });

    expect(readJson(configPath).provider['campus-llm'].models.kept).toEqual({
      name: 'Kept',
      reasoning: true,
      options: { instructions: 'stay' },
    });
  });

  test('upsertProviderConfig reads and rewrites a project opencode.jsonc', () => {
    const configPath = path.join(projectDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, [
      '{',
      '  // capabilities live here',
      '  "provider": {',
      '    "campus-llm": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "name": "Old",',
      '      "options": { "baseURL": "https://old.example.edu/v1" },',
      '      "models": { "a": { "name": "A" } },',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8');

    const result = upsertProviderConfig('campus-llm', {
      name: 'Campus LLM',
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: { b: { name: 'B' } },
    }, projectDir, 'project', { hasStoredAuth: true });

    expect(result.path).toBe(configPath);
    // Rewrite drops comments but keeps JSON valid at the same .jsonc path and backs up first.
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.provider['campus-llm'].name).toBe('Campus LLM');
    expect(written.provider['campus-llm'].models).toEqual({ b: { name: 'B' } });
    expect(fs.existsSync(`${configPath}.openchamber.backup`)).toBe(true);
  });
});
