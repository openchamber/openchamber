import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listPluginEntries,
  updateMcpConfig,
  createMcpConfig,
  deleteMcpConfig,
  type JsonValue,
} from './opencodeConfig';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

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

describe('opencodeConfig comment-preserving config writes (issue #3587)', () => {
  let tempDir: string;
  let previousOpenCodeConfig: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-write-'));
    previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
  });

  afterEach(() => {
    if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const COMMENTED_CONFIG = [
    '{',
    '  // schema for editor hints',
    '  "$schema": "https://opencode.ai/config.json",',
    '  /* my servers */',
    '  "mcp": {',
    '    "openproject": {',
    '      "type": "remote",',
    '      "url": "https://openproject.example.com/mcp",',
    '      "enabled": false, // toggle per environment',
    '    }',
    '  },',
    '  "plugin": ["opencode-see-image"],',
    '}',
    '',
  ].join('\n');

  const writeConfigFile = (name: string, content: string): string => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  };

  // Reads the exact file state; merged-layer APIs would also surface this
  // machine's real user config and make the assertions machine-dependent.
  // The deepEqual assertions against full expected objects carry the contract.
  const readConfigFileJsonc = (filePath: string): JsonValue => {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(fs.readFileSync(filePath, 'utf8'), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0);
    return parsed;
  };

  test('keeps every comment when a single MCP value changes', () => {
    const configPath = writeConfigFile('opencode.jsonc', COMMENTED_CONFIG);
    process.env.OPENCODE_CONFIG = configPath;

    updateMcpConfig('openproject', { enabled: true });

    const raw = fs.readFileSync(configPath, 'utf8');
    assert.ok(raw.includes('// schema for editor hints'));
    assert.ok(raw.includes('/* my servers */'));
    assert.ok(raw.includes('// toggle per environment'));
    assert.deepEqual(readConfigFileJsonc(configPath), {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        openproject: {
          type: 'remote',
          url: 'https://openproject.example.com/mcp',
          enabled: true,
        },
      },
      plugin: ['opencode-see-image'],
    });
    assert.equal(fs.readFileSync(`${configPath}.openchamber.backup`, 'utf8'), COMMENTED_CONFIG);
  });

  test('keeps comments when adding a new MCP server', () => {
    const configPath = writeConfigFile('opencode.jsonc', COMMENTED_CONFIG);
    process.env.OPENCODE_CONFIG = configPath;

    createMcpConfig('linear', { type: 'remote', url: 'https://mcp.linear.app/sse' });

    const raw = fs.readFileSync(configPath, 'utf8');
    assert.ok(raw.includes('// schema for editor hints'));
    assert.ok(raw.includes('/* my servers */'));
    assert.ok(raw.includes('// toggle per environment'));
    assert.deepEqual(readConfigFileJsonc(configPath), {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        openproject: {
          type: 'remote',
          url: 'https://openproject.example.com/mcp',
          enabled: false,
        },
        linear: {
          type: 'remote',
          url: 'https://mcp.linear.app/sse',
          enabled: true,
        },
      },
      plugin: ['opencode-see-image'],
    });
  });

  test('keeps comments when deleting an MCP server and the emptied section', () => {
    const configPath = writeConfigFile('opencode.jsonc', COMMENTED_CONFIG);
    process.env.OPENCODE_CONFIG = configPath;

    deleteMcpConfig('openproject');

    const raw = fs.readFileSync(configPath, 'utf8');
    assert.ok(raw.includes('// schema for editor hints'));
    assert.ok(raw.includes('/* my servers */'));
    assert.deepEqual(readConfigFileJsonc(configPath), {
      $schema: 'https://opencode.ai/config.json',
      plugin: ['opencode-see-image'],
    });
  });

  test('keeps comments when deleting the only property of a trailing-comma object', () => {
    const configPath = writeConfigFile('trailing-comma.jsonc', [
      '{',
      '  // the only entry',
      '  "mcp": {',
      '    "openproject": { "type": "remote", "url": "https://x", "enabled": true },',
      '  },',
      '}',
      '',
    ].join('\n'));
    process.env.OPENCODE_CONFIG = configPath;

    deleteMcpConfig('openproject');

    assert.ok(fs.readFileSync(configPath, 'utf8').includes('// the only entry'));
    assert.deepEqual(readConfigFileJsonc(configPath), {});
  });

  test('appends the config after comments of a comment-only file', () => {
    const configPath = writeConfigFile('comments-only.jsonc', '// placeholder\n/* still empty */\n');
    process.env.OPENCODE_CONFIG = configPath;

    createMcpConfig('linear', { type: 'remote', url: 'https://mcp.linear.app/sse' });

    const raw = fs.readFileSync(configPath, 'utf8');
    assert.ok(raw.includes('// placeholder'));
    assert.ok(raw.includes('/* still empty */'));
    assert.deepEqual(readConfigFileJsonc(configPath), {
      mcp: { linear: { type: 'remote', url: 'https://mcp.linear.app/sse', enabled: true } },
    });
  });

  test('writes a new config file as plain JSON when it is missing', () => {
    const configPath = path.join(tempDir, 'fresh.jsonc');
    process.env.OPENCODE_CONFIG = configPath;

    createMcpConfig('linear', { type: 'remote', url: 'https://mcp.linear.app/sse' });

    assert.equal(
      fs.readFileSync(configPath, 'utf8'),
      JSON.stringify({
        mcp: { linear: { type: 'remote', enabled: true, url: 'https://mcp.linear.app/sse' } },
      }, null, 2),
    );
  });

  test('leaves the file byte-identical when nothing changed', () => {
    const configPath = writeConfigFile('unchanged.jsonc', COMMENTED_CONFIG);
    process.env.OPENCODE_CONFIG = configPath;

    updateMcpConfig('openproject', { enabled: false });

    assert.equal(fs.readFileSync(configPath, 'utf8'), COMMENTED_CONFIG);
  });

  test('preserves CRLF line endings and comments', () => {
    const configPath = writeConfigFile('crlf.jsonc', [
      '{',
      '  // windows file',
      '  "mcp": {',
      '    "openproject": { "type": "remote", "url": "https://x", "enabled": false }',
      '  },',
      '}',
      '',
    ].join('\r\n'));
    process.env.OPENCODE_CONFIG = configPath;

    updateMcpConfig('openproject', { enabled: true });

    const raw = fs.readFileSync(configPath, 'utf8');
    assert.ok(raw.includes('\r\n'));
    assert.ok(raw.includes('// windows file'));
    assert.deepEqual(readConfigFileJsonc(configPath), {
      mcp: {
        openproject: { type: 'remote', url: 'https://x', enabled: true },
      },
    });
  });

  test('falls back to a normalized rewrite when the edit cannot round-trip', () => {
    const configPath = writeConfigFile('duplicate-keys.jsonc', [
      '{',
      '  "mcp": { "x": { "type": "remote", "url": "https://x", "enabled": true } },',
      '  "mcp": { "y": { "type": "remote", "url": "https://y", "enabled": true } },',
      '}',
      '',
    ].join('\n'));
    process.env.OPENCODE_CONFIG = configPath;

    deleteMcpConfig('y');

    assert.equal(fs.readFileSync(configPath, 'utf8'), JSON.stringify({}, null, 2));
  });
});
