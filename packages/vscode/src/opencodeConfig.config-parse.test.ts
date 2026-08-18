import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listPluginEntries, updateMcpConfig } from './opencodeConfig';

const PARTIAL_PARSE_CONFIG = [
  '{',
  '  "$schema": "https://opencode.ai/config.json",',
  '  plugin: ["opencode-see-image"],',
  '  mcp: {',
  '    openproject: {',
  '      type: "remote",',
  '      url: "https://openproject.example.com/mcp",',
  '      enabled: true',
  '    }',
  '  },',
  '  provider: {',
  '    "ollama-cloud": {',
  '      npm: "@ai-sdk/openai-compatible",',
  '      name: "Ollama Cloud"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const VALID_CONFIG = [
  '{',
  '  "$schema": "https://opencode.ai/config.json",',
  '  "plugin": ["opencode-see-image"],',
  '  "mcp": {',
  '    "openproject": {',
  '      "type": "remote",',
  '      "url": "https://openproject.example.com/mcp",',
  '      "enabled": true',
  '    }',
  '  },',
  '  "provider": {',
  '    "ollama-cloud": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "name": "Ollama Cloud"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const isInvalidJsoncError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !/cannot be loaded safely/.test(error.message)) {
    return false;
  }
  // SAFETY: the config layer throws Error instances carrying the coded `code` field.
  return (error as Error & { code?: string }).code === 'INVALID_JSONC';
};

describe('opencodeConfig JSONC parse safety (issue #2923)', () => {
  let tempDir: string;
  let previousOpenCodeConfig: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-parse-'));
    previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
  });

  afterEach(() => {
    if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('refuses MCP updates that would overwrite a partial-parse config', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, PARTIAL_PARSE_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    assert.throws(() => updateMcpConfig('openproject', { enabled: true }), isInvalidJsoncError);
    assert.equal(fs.readFileSync(configPath, 'utf8'), PARTIAL_PARSE_CONFIG);
    assert.equal(fs.existsSync(`${configPath}.openchamber.backup`), false);
  });

  test('preserves unrelated keys when updating a valid MCP config', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, VALID_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    updateMcpConfig('openproject', { enabled: false });

    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(rewritten.plugin, ['opencode-see-image']);
    assert.equal(rewritten.provider['ollama-cloud'].name, 'Ollama Cloud');
    assert.equal(rewritten.mcp.openproject.enabled, false);
    assert.equal(fs.readFileSync(`${configPath}.openchamber.backup`, 'utf8'), VALID_CONFIG);
  });

  test('returns an empty object for a comment-only config file', () => {
    const configPath = path.join(tempDir, 'comments.jsonc');
    fs.writeFileSync(configPath, '// placeholder\n/* still empty */\n', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    assert.deepEqual(listPluginEntries(), []);
  });

  test('refuses MCP updates against content that yields no JSON value at all', () => {
    const configPath = path.join(tempDir, 'yamlish.jsonc');
    const contents = 'mcp:\n  openproject:\n    type: remote\n';
    fs.writeFileSync(configPath, contents, 'utf8');
    process.env.OPENCODE_CONFIG = configPath;

    assert.throws(() => updateMcpConfig('openproject', { enabled: true }), isInvalidJsoncError);
    assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
    assert.equal(fs.existsSync(`${configPath}.openchamber.backup`), false);
  });

  test('lists custom-layer plugins when a project layer is unparseable', () => {
    const customPath = path.join(tempDir, 'custom.jsonc');
    const projectDir = path.join(tempDir, 'project');
    const projectFile = path.join(projectDir, '.opencode', 'opencode.jsonc');
    fs.writeFileSync(customPath, VALID_CONFIG, 'utf8');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, PARTIAL_PARSE_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = customPath;

    const specs = listPluginEntries(projectDir).map((entry) => entry.spec);
    assert.deepEqual(specs, ['opencode-see-image']);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), PARTIAL_PARSE_CONFIG);
    assert.equal(fs.existsSync(`${projectFile}.openchamber.backup`), false);
  });

  test('keeps a valid custom layer writable when a project layer is unparseable', () => {
    const customPath = path.join(tempDir, 'custom.jsonc');
    const projectDir = path.join(tempDir, 'project');
    const projectFile = path.join(projectDir, '.opencode', 'opencode.jsonc');
    fs.writeFileSync(customPath, VALID_CONFIG, 'utf8');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, PARTIAL_PARSE_CONFIG, 'utf8');
    process.env.OPENCODE_CONFIG = customPath;

    updateMcpConfig('openproject', { enabled: false }, projectDir);

    const rewritten = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    assert.deepEqual(rewritten.plugin, ['opencode-see-image']);
    assert.equal(rewritten.mcp.openproject.enabled, false);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), PARTIAL_PARSE_CONFIG);
    assert.equal(fs.existsSync(`${projectFile}.openchamber.backup`), false);
  });
});
