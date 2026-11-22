import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readConfigFile, readConfigLayer, readConfigLayers, writeConfig, MAX_CONFIG_FILE_BYTES } from './config-files.js';
import { parseMdFile, parseMdFileAsync, MD_FILE_MAX_BYTES, writeMdFile } from './markdown-files.js';
import { walkSkillMdFiles, listSkillSupportingFiles } from './skill-files.js';

// The skill walks state these values at their budget creation in skill-files.ts
// (design #1391: values live with the walk, not in exported constants);
// the cap tests below exercise the walks at exactly these values.
const SKILL_WALK_MAX_DIRS = 5000;
const SKILL_SUPPORTING_FILES_MAX_DIRECTORIES = 5000;
const SKILL_SUPPORTING_FILES_MAX_FILES = 5000;
import { updateAgent } from './agents.js';
import { updateMcpConfig, createMcpConfig, deleteMcpConfig } from './mcp.js';
import { encodePluginId, updatePluginEntry } from './plugins.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-shared-test-${process.pid}`);

const STANDARD_MD = [
  '---',
  'description: My build agent',
  'model: anthropic/claude-sonnet-4',
  'mode: primary',
  '---',
  '',
  'This is the prompt body.',
  '',
].join('\n');

const writeFixture = (name, content) => {
  const filePath = path.join(FIXTURE_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

describe('readConfigFile / writeConfig JSONC safety (issue #2923)', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const VALID_CONFIG = [
    '{',
    '  "$schema": "https://opencode.ai/config.json",',
    '  // keep me',
    '  "plugin": ["opencode-see-image"],',
    '  "mcp": {',
    '    "openproject": {',
    '      "type": "remote",',
    '      "url": "https://openproject.example.com/mcp",',
    '      "enabled": true,',
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

  // JSON5-style unquoted keys after $schema — jsonc-parser returns a partial
  // tree of only `{ $schema }` when errors are ignored.
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

  it('parses valid JSONC with comments and trailing commas without dropping keys', () => {
    const file = writeFixture('opencode.jsonc', VALID_CONFIG);
    expect(readConfigFile(file)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['opencode-see-image'],
      mcp: {
        openproject: {
          type: 'remote',
          url: 'https://openproject.example.com/mcp',
          enabled: true,
        },
      },
      provider: {
        'ollama-cloud': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama Cloud',
        },
      },
    });
  });

  it('returns an empty object for a missing or whitespace-only file', () => {
    expect(readConfigFile(path.join(FIXTURE_DIR, 'missing.jsonc'))).toEqual({});
    const empty = writeFixture('empty.jsonc', '   \n');
    expect(readConfigFile(empty)).toEqual({});
  });

  it('throws INVALID_JSONC on partial-parse JSONC instead of returning a $schema-only stub', () => {
    const file = writeFixture('opencode.jsonc', PARTIAL_PARSE_CONFIG);
    expect(() => readConfigFile(file)).toThrow(/cannot be loaded safely/);
    try {
      readConfigFile(file);
    } catch (error) {
      expect(error.code).toBe('INVALID_JSONC');
    }
  });

  it('throws INVALID_JSONC for a non-object JSONC root', () => {
    const file = writeFixture('array.jsonc', '["plugin"]\n');
    expect(() => readConfigFile(file)).toThrow(/cannot be loaded safely/);
  });

  it('refuses to overwrite an unparseable config file', () => {
    const file = writeFixture('opencode.jsonc', PARTIAL_PARSE_CONFIG);
    expect(() => writeConfig({ $schema: 'https://opencode.ai/config.json' }, file)).toThrow(
      /cannot be loaded safely/,
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(PARTIAL_PARSE_CONFIG);
    expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(false);
  });

  it('preserves a valid config across MCP updates', () => {
    const file = writeFixture('opencode.jsonc', VALID_CONFIG);
    const config = readConfigFile(file);
    config.mcp.openproject.enabled = false;
    writeConfig(config, file);

    const rewritten = readConfigFile(file);
    expect(rewritten.plugin).toEqual(['opencode-see-image']);
    expect(rewritten.provider['ollama-cloud'].name).toBe('Ollama Cloud');
    expect(rewritten.mcp.openproject.enabled).toBe(false);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(VALID_CONFIG);
  });

  it('does not wipe an unparseable user config during MCP mutation attempts', () => {
    const file = writeFixture('opencode.jsonc', PARTIAL_PARSE_CONFIG);
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;

    try {
      process.env.OPENCODE_CONFIG = file;
      expect(() => updateMcpConfig('openproject', { enabled: true })).toThrow(
        /cannot be loaded safely/,
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(PARTIAL_PARSE_CONFIG);
      expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(false);
    } finally {
      if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    }
  });

  it('returns an empty object for a comment-only config file', () => {
    const file = writeFixture('comments.jsonc', '// placeholder\n/* still empty */\n');
    expect(readConfigFile(file)).toEqual({});
  });

  it('throws INVALID_JSONC for content that yields no JSON value at all', () => {
    const yamlish = writeFixture('yamlish.jsonc', 'mcp:\n  openproject:\n    type: remote\n');
    expect(() => readConfigFile(yamlish)).toThrow(/cannot be loaded safely/);
    expect(() => writeConfig({ $schema: 'https://opencode.ai/config.json' }, yamlish)).toThrow(
      /cannot be loaded safely/,
    );
    expect(fs.readFileSync(yamlish, 'utf8')).toBe('mcp:\n  openproject:\n    type: remote\n');
    expect(fs.existsSync(`${yamlish}.openchamber.backup`)).toBe(false);
  });

  it('keeps a valid custom layer readable when a project layer is unparseable', () => {
    const custom = writeFixture('custom.jsonc', VALID_CONFIG);
    const projectDir = path.join(FIXTURE_DIR, 'project');
    const projectFile = writeFixture(path.join('project', '.opencode', 'opencode.jsonc'), PARTIAL_PARSE_CONFIG);
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;

    try {
      process.env.OPENCODE_CONFIG = custom;
      const layers = readConfigLayers(projectDir);
      expect(layers.customConfig.plugin).toEqual(['opencode-see-image']);
      expect(layers.projectConfig).toEqual({});
      expect(layers.mergedConfig.plugin).toEqual(['opencode-see-image']);
      expect(layers.layerErrors).toEqual([
        expect.objectContaining({
          path: projectFile,
          code: 'INVALID_JSONC',
        }),
      ]);

      updateMcpConfig('openproject', { disabled: true }, projectDir);
      const rewritten = readConfigFile(custom);
      expect(rewritten.plugin).toEqual(['opencode-see-image']);
      // The v1 `mcp.<name>` entry is rewritten in place into `mcp.servers`.
      expect(rewritten.mcp.openproject).toBeUndefined();
      expect(rewritten.mcp.servers.openproject.disabled).toBe(true);
      expect(fs.readFileSync(projectFile, 'utf8')).toBe(PARTIAL_PARSE_CONFIG);
      expect(fs.existsSync(`${projectFile}.openchamber.backup`)).toBe(false);
    } finally {
      if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    }
  });
});

describe('readConfigFile / writeConfig size cap (issue #1150)', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const writeOversizedConfig = (name) => {
    const filePath = writeFixture(name, '{"pad":""}');
    fs.truncateSync(filePath, MAX_CONFIG_FILE_BYTES + 1);
    return filePath;
  };

  it('refuses an over-cap config without reading it whole', () => {
    const file = writeOversizedConfig('too-big.json');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    let thrown;
    try {
      readConfigFile(file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('CONFIG_FILE_TOO_LARGE');
    expect(thrown?.message).toMatch(/byte limit/);
    expect(readSpy.mock.calls.some(([target]) => target === file)).toBe(false);
  });

  it('refuses a config that grows past the cap after the handle stat without buffering it whole (#1410)', () => {
    const file = writeFixture('grown.json', `{"padding":"${'x'.repeat(MAX_CONFIG_FILE_BYTES)}"}`);
    expect(fs.statSync(file).size).toBeGreaterThan(MAX_CONFIG_FILE_BYTES);

    // The descriptor growth case: the handle stat answers the pre-growth
    // size while the read meets the grown file.
    const realFstatSync = fs.fstatSync;
    const realReadSync = fs.readSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
      const stats = realFstatSync(fd);
      Object.defineProperty(stats, 'size', { value: 10 });
      return stats;
    });
    let requested = 0;
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, offset, length, position) => {
      requested += length;
      return realReadSync(fd, buffer, offset, length, position);
    });

    let thrown;
    try {
      readConfigFile(file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('CONFIG_FILE_TOO_LARGE');
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(MAX_CONFIG_FILE_BYTES + 1);
  });

  it('records the over-cap refusal as a layer error instead of a silent empty config', () => {
    const file = writeOversizedConfig('layer-too-big.jsonc');
    const layer = readConfigLayer(file);
    expect(layer.config).toEqual({});
    expect(layer.error?.code).toBe('CONFIG_FILE_TOO_LARGE');
  });

  it('writeConfig refuses to overwrite an over-cap existing config', () => {
    const file = writeOversizedConfig('existing-too-big.json');
    const before = fs.statSync(file).size;

    let thrown;
    try {
      writeConfig({ $schema: 'https://opencode.ai/config.json' }, file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('CONFIG_FILE_TOO_LARGE');
    expect(fs.statSync(file).size).toBe(before);
    expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(false);
  });

  it('writeConfig refuses a serialized result over the byte cap and preserves the original', () => {
    const original = JSON.stringify({ $schema: 'https://opencode.ai/config.json' });
    const file = writeFixture('grows-over-cap.json', original);
    fs.writeFileSync(`${file}.openchamber.backup`, 'previous backup');
    const huge = { pad: 'x'.repeat(MAX_CONFIG_FILE_BYTES) };

    let thrown;
    try {
      writeConfig(huge, file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('CONFIG_FILE_TOO_LARGE');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe('previous backup');
    expect(readConfigFile(file)).toEqual({ $schema: 'https://opencode.ai/config.json' });
  });

  it('loads and rewrites a config exactly at the byte cap', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ pad: '' }), 'utf8');
    const pad = 'x'.repeat(MAX_CONFIG_FILE_BYTES - overhead);
    const file = writeFixture('at-cap.json', JSON.stringify({ pad }));
    expect(fs.statSync(file).size).toBe(MAX_CONFIG_FILE_BYTES);

    expect(readConfigFile(file)).toEqual({ pad });
    writeConfig({ pad }, file);
    expect(readConfigFile(file)).toEqual({ pad });
  });
});

describe('walkSkillMdFiles', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const writeSkill = (relativeDir) => writeFixture(path.join(relativeDir, 'SKILL.md'), STANDARD_MD);
  // A junction needs no elevation on Windows, which is what Skills Manager deploys;
  // the type argument is ignored on POSIX.
  const linkDirectory = (target, relativeLink) =>
    fs.symlinkSync(target, path.join(FIXTURE_DIR, relativeLink), process.platform === 'win32' ? 'junction' : 'dir');
  const foundRelative = async () =>
    (await walkSkillMdFiles(FIXTURE_DIR))
      .map((found) => path.relative(FIXTURE_DIR, found).split(path.sep).join('/'))
      .sort();

  it('walks a skill deployed as a link inside the scanned root', async () => {
    writeSkill('real-skill');
    fs.mkdirSync(path.join(FIXTURE_DIR, 'collection'), { recursive: true });
    writeSkill(path.join('collection', 'nested-skill'));
    linkDirectory(path.join(FIXTURE_DIR, 'real-skill'), 'linked-skill');
    linkDirectory(path.join(FIXTURE_DIR, 'collection'), 'collection-link');

    expect(await foundRelative()).toEqual([
      'collection-link/nested-skill/SKILL.md',
      'collection/nested-skill/SKILL.md',
      'linked-skill/SKILL.md',
      'real-skill/SKILL.md',
    ]);
  });

  it('ends on a link that points back into the scanned tree', async () => {
    fs.mkdirSync(path.join(FIXTURE_DIR, 'loopdir'), { recursive: true });
    writeSkill('loopdir');
    linkDirectory(FIXTURE_DIR, path.join('loopdir', 'back'));

    expect(await foundRelative()).toEqual(['loopdir/SKILL.md']);
  });

  it('skips a link whose target is gone and keeps the rest of the scan', async () => {
    writeSkill('real-skill');
    fs.mkdirSync(path.join(FIXTURE_DIR, 'gone-skill'), { recursive: true });
    linkDirectory(path.join(FIXTURE_DIR, 'gone-skill'), 'dangling-link');
    fs.rmSync(path.join(FIXTURE_DIR, 'gone-skill'), { recursive: true, force: true });

    expect(await foundRelative()).toEqual(['real-skill/SKILL.md']);
  });

  it('follows a link nested below the top level of the scanned root', async () => {
    const outside = `${FIXTURE_DIR}-outside`;
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, 'deep-skill'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'deep-skill', 'SKILL.md'), STANDARD_MD);
    fs.mkdirSync(path.join(FIXTURE_DIR, 'group'), { recursive: true });
    try {
      linkDirectory(path.join(outside, 'deep-skill'), path.join('group', 'linked'));
      expect(await foundRelative()).toEqual(['group/linked/SKILL.md']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ends on a nested link loop between two directories', async () => {
    fs.mkdirSync(path.join(FIXTURE_DIR, 'a'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'b'), { recursive: true });
    writeSkill('a');
    linkDirectory(path.join(FIXTURE_DIR, 'b'), path.join('a', 'to-b'));
    linkDirectory(path.join(FIXTURE_DIR, 'a'), path.join('b', 'to-a'));

    expect(await foundRelative()).toEqual(['a/SKILL.md', 'b/to-a/SKILL.md']);
  });
});

describe('writeConfig preserves JSONC comments (issue #3587)', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const COMMENTED_CONFIG = [
    '{',
    '  // schema for editor hints',
    '  "$schema": "https://opencode.ai/config.json",',
    '  /* my servers */',
    '  "mcp": {',
    '    "servers": {',
    '      "openproject": {',
    '        "type": "remote",',
    '        "url": "https://openproject.example.com/mcp",',
    '        "disabled": true, // toggle per environment',
    '      }',
    '    }',
    '  },',
    '  "plugin": ["opencode-see-image"],',
    '}',
    '',
  ].join('\n');

  const withCustomConfig = (file, run) => {
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
    try {
      process.env.OPENCODE_CONFIG = file;
      return run();
    } finally {
      if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    }
  };

  it('keeps every comment when a single MCP value changes', () => {
    const file = writeFixture('opencode.jsonc', COMMENTED_CONFIG);

    withCustomConfig(file, () => updateMcpConfig('openproject', { disabled: false }));

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// schema for editor hints');
    expect(raw).toContain('/* my servers */');
    expect(raw).toContain('// toggle per environment');
    expect(readConfigFile(file)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          openproject: {
            type: 'remote',
            url: 'https://openproject.example.com/mcp',
            disabled: false,
          },
        },
      },
      plugin: ['opencode-see-image'],
    });
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(COMMENTED_CONFIG);
  });

  it('keeps comments when adding a new MCP server', () => {
    const file = writeFixture('opencode.jsonc', COMMENTED_CONFIG);

    // A name no real global config carries: the user-level config of the
    // machine running the tests is still read, and an existing entry there
    // would make the create fail.
    withCustomConfig(file, () => createMcpConfig('jsonc-comment-fixture', { type: 'remote', url: 'https://mcp.linear.app/sse' }));

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// schema for editor hints');
    expect(raw).toContain('/* my servers */');
    expect(raw).toContain('// toggle per environment');
    expect(readConfigFile(file).mcp.servers['jsonc-comment-fixture']).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/sse',
    });
    expect(readConfigFile(file).mcp.servers.openproject.disabled).toBe(true);
  });

  it('keeps comments when deleting an MCP server and the emptied section', () => {
    const file = writeFixture('opencode.jsonc', COMMENTED_CONFIG);

    withCustomConfig(file, () => deleteMcpConfig('openproject'));

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// schema for editor hints');
    expect(raw).toContain('/* my servers */');
    const rewritten = readConfigFile(file);
    expect(rewritten.mcp).toBeUndefined();
    expect(rewritten.plugin).toEqual(['opencode-see-image']);
  });

  it('keeps comments when deleting the only property of a trailing-comma object', () => {
    const file = writeFixture('trailing-comma.jsonc', [
      '{',
      '  // the only entry',
      '  "mcp": {',
      '    "servers": {',
      '      "openproject": { "type": "remote", "url": "https://x", "disabled": true },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'));

    withCustomConfig(file, () => deleteMcpConfig('openproject'));

    expect(fs.readFileSync(file, 'utf8')).toContain('// the only entry');
    expect(readConfigFile(file)).toEqual({});
  });

  it('keeps a standalone comment between a removed property and the next one', () => {
    const file = writeFixture('gap-comment.jsonc', [
      '{',
      '  "a": 1,',
      '  // about b',
      '  "b": 2,',
      '}',
      '',
    ].join('\n'));

    const config = readConfigFile(file);
    delete config.a;
    writeConfig(config, file);

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// about b');
    expect(readConfigFile(file)).toEqual({ b: 2 });
  });

  it('appends the config after comments of a comment-only file', () => {
    const file = writeFixture('comments-only.jsonc', '// placeholder\n/* still empty */\n');

    writeConfig({ $schema: 'https://opencode.ai/config.json' }, file);

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// placeholder');
    expect(raw).toContain('/* still empty */');
    expect(readConfigFile(file)).toEqual({ $schema: 'https://opencode.ai/config.json' });
  });

  it('writes a new file as plain JSON when it is missing or empty', () => {
    const file = path.join(FIXTURE_DIR, 'fresh.jsonc');
    writeConfig({ $schema: 'https://opencode.ai/config.json' }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2),
    );

    const empty = writeFixture('empty.jsonc', '');
    writeConfig({ $schema: 'https://opencode.ai/config.json' }, empty);
    expect(fs.readFileSync(empty, 'utf8')).toBe(
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2),
    );
  });

  it('leaves the file byte-identical when nothing changed', () => {
    const file = writeFixture('unchanged.jsonc', COMMENTED_CONFIG);

    writeConfig(readConfigFile(file), file);

    expect(fs.readFileSync(file, 'utf8')).toBe(COMMENTED_CONFIG);
  });

  it('preserves untouched array entries during a plugin version update', () => {
    const original = [
      '{',
      '  "plugins": [',
      '    // plugin A stays as written',
      '    {',
      '      "package": "example-plugin-a",',
      '      "options": {',
      '        // keep this timeout comment',
      '        "timeoutMs": 5000,',
      '      },',
      '    }, /* after plugin A */',
      '    // plugin B changes version',
      '    "example-plugin-b@1.0.0", // keep this entry comment',
      '  ],',
      '}',
      '',
    ].join('\n');
    const file = writeFixture('plugins.jsonc', original);

    withCustomConfig(file, () => updatePluginEntry(
      encodePluginId('config', 'user:example-plugin-b@1.0.0'),
      { spec: 'example-plugin-b@2.0.0' },
    ));

    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('example-plugin-b@1.0.0', 'example-plugin-b@2.0.0'));
    expect(readConfigFile(file)).toEqual({
      plugins: [
        { package: 'example-plugin-a', options: { timeoutMs: 5000 } },
        'example-plugin-b@2.0.0',
      ],
    });
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(original);
  });

  it('preserves array comments when plugin options and a nested array entry change', () => {
    const original = [
      '{',
      '  "plugins": [',
      '    { "package": "example-plugin-a", "options": { /* keep A */ "timeoutMs": 5000 } },',
      '    {',
      '      "package": "example-plugin-b",',
      '      "options": {',
      '        // keep the timeout explanation',
      '        "timeoutMs": 7000,',
      '        "retries": [',
      '          1,',
      '          1, // keep the unchanged duplicate delay',
      '          2,',
      '          3,',
      '        ],',
      '      },',
      '    },',
      '  ],',
      '}',
      '',
    ].join('\n');
    const file = writeFixture('plugin-options.jsonc', original);

    withCustomConfig(file, () => updatePluginEntry(
      encodePluginId('config', 'user:example-plugin-b'),
      { options: { timeoutMs: 9000, retries: [2, 1, 2, 4] } },
    ));

    expect(fs.readFileSync(file, 'utf8')).toBe(original
      .replace('"timeoutMs": 7000', '"timeoutMs": 9000')
      .replace('          1,', '          2,')
      .replace('          3,', '          4,'));
    expect(readConfigFile(file)).toEqual({
      plugins: [
        { package: 'example-plugin-a', options: { timeoutMs: 5000 } },
        { package: 'example-plugin-b', options: { timeoutMs: 9000, retries: [2, 1, 2, 4] } },
      ],
    });
  });

  const retainedObject = { package: 'example-plugin-a', options: { timeoutMs: 5000 } };
  for (const [name, next] of [
    ['insert in the middle', [retainedObject, 'x', 'b', 'c']],
    ['reorder', ['b', 'd', 'c']],
  ]) {
    it(`round-trips a whole-array replacement for ${name}`, () => {
      const file = writeFixture('array-replacement.jsonc', [
        '{',
        '  // keep the section comment',
        '  "values": [',
        '    { "package": "example-plugin-a", "options": { /* old position */ "timeoutMs": 5000 } },',
        '    "b",',
        '    "c",',
        '  ],',
        '}',
        '',
      ].join('\n'));

      writeConfig({ values: next }, file);

      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('// keep the section comment');
      expect(raw).not.toContain('/* old position */');
      expect(readConfigFile(file)).toEqual({ values: next });
    });
  }

  it('appends and removes array elements in place, keeping the other elements and comments', () => {
    const original = [
      '{',
      '  "values": [',
      '    // a',
      '    { "id": "a" }, // after a',
      '    // b',
      '    "b",',
      '    "c", // after c',
      '  ],',
      '}',
      '',
    ].join('\r\n');
    const file = writeFixture('array-elements.jsonc', original);

    writeConfig({ values: [{ id: 'a' }, 'b', 'c', 'd'] }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('  ],', '    "d"\r\n  ],'));

    writeConfig({ values: [{ id: 'a' }, 'c'] }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe([
      '{',
      '  "values": [',
      '    // a',
      '    { "id": "a" }, // after a',
      '    // b',
      '    "c" // after c',
      '  ],',
      '}',
      '',
    ].join('\r\n'));
  });

  it('preserves CRLF line endings and comments', () => {
    const file = writeFixture('crlf.jsonc', [
      '{',
      '  // windows file',
      '  "mcp": {',
      '    "servers": {',
      '      "openproject": { "type": "remote", "url": "https://x", "disabled": true }',
      '    }',
      '  },',
      '}',
      '',
    ].join('\r\n'));

    withCustomConfig(file, () => updateMcpConfig('openproject', { disabled: false }));

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('\r\n');
    expect(raw).toContain('// windows file');
    expect(readConfigFile(file).mcp.servers.openproject.disabled).toBe(false);
  });

  it('falls back to a normalized rewrite when the edit cannot round-trip', () => {
    const file = writeFixture('duplicate-keys.jsonc', '{\n  "a": 1,\n  "a": 2,\n}\n');

    writeConfig({ a: 3 }, file);

    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 3 }, null, 2));
  });
});

describe('writeConfig replaces the file atomically', () => {
  const OLD_CONFIG = '{\n  // keep me\n  "a": 1,\n}\n';

  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('writes a sibling temp file and renames it over the target', () => {
    const file = writeFixture('opencode.jsonc', OLD_CONFIG);
    const inodeBefore = fs.statSync(file).ino;
    const realRename = fs.renameSync;
    const seen = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // At the moment of the swap the target still holds the old, complete
      // file and the temp file already holds the complete new one.
      seen.push({
        from,
        to,
        target: fs.readFileSync(file, 'utf8'),
        temp: fs.readFileSync(from, 'utf8'),
      });
      return realRename(from, to);
    });

    writeConfig({ a: 2 }, file);

    // The writer resolves symlinks, and on macOS the temp dir lives under one.
    const realFile = fs.realpathSync(file);
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0].from)).toBe(path.dirname(realFile));
    expect(seen[0].to).toBe(realFile);
    expect(seen[0].target).toBe(OLD_CONFIG);
    expect(seen[0].temp).toBe('{\n  // keep me\n  "a": 2,\n}\n');
    expect(fs.statSync(file).ino).not.toBe(inodeBefore);
    expect(readConfigFile(file)).toEqual({ a: 2 });
    expect(fs.readdirSync(FIXTURE_DIR).sort()).toEqual(['opencode.jsonc', 'opencode.jsonc.openchamber.backup']);
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of the existing file', () => {
    const file = writeFixture('opencode.jsonc', OLD_CONFIG);
    fs.chmodSync(file, 0o640);

    writeConfig({ a: 2 }, file);

    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a read-only config', () => {
    const file = writeFixture('opencode.jsonc', OLD_CONFIG);
    fs.chmodSync(file, 0o444);

    expect(() => writeConfig({ a: 2 }, file)).toThrow('Failed to write OpenCode configuration');

    expect(fs.readFileSync(file, 'utf8')).toBe(OLD_CONFIG);
  });

  it('still writes the backup of the previous content', () => {
    const file = writeFixture('opencode.jsonc', OLD_CONFIG);

    writeConfig({ a: 2 }, file);

    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(OLD_CONFIG);
  });

  it('still refuses an unparseable file and leaves no temp file behind', () => {
    const broken = '{\n  "a": 1,\n  plugin: ["x"]\n}\n';
    const file = writeFixture('opencode.jsonc', broken);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(() => writeConfig({ a: 2 }, file)).toThrow(/cannot be loaded safely/);

    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
    expect(fs.readdirSync(FIXTURE_DIR)).toEqual(['opencode.jsonc']);
  });

  it('leaves the original untouched and removes the temp file when the rename fails', () => {
    const file = writeFixture('opencode.jsonc', OLD_CONFIG);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('boom'), { code: 'EIO' });
    });

    expect(() => writeConfig({ a: 2 }, file)).toThrow('Failed to write OpenCode configuration');

    expect(fs.readFileSync(file, 'utf8')).toBe(OLD_CONFIG);
    expect(fs.readdirSync(FIXTURE_DIR).sort()).toEqual(['opencode.jsonc', 'opencode.jsonc.openchamber.backup']);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked config instead of replacing the link', () => {
    const real = writeFixture('dotfiles/opencode.jsonc', OLD_CONFIG);
    const link = path.join(FIXTURE_DIR, 'opencode.jsonc');
    fs.symlinkSync(real, link);

    writeConfig({ a: 2 }, link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readConfigFile(real)).toEqual({ a: 2 });
  });

  it.skipIf(process.platform === 'win32')('creates the file a dangling symlinked config points at', () => {
    const real = path.join(FIXTURE_DIR, 'dotfiles', 'opencode.jsonc');
    const link = path.join(FIXTURE_DIR, 'opencode.jsonc');
    fs.symlinkSync(real, link);

    writeConfig({ a: 2 }, link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readConfigFile(real)).toEqual({ a: 2 });
  });
});

describe('listSkillSupportingFiles caps (#1365)', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const SKILL_DIR = () => path.join(FIXTURE_DIR, 'skill');

  const writeSupporting = (relativePath, content = 'x') => {
    const filePath = path.join(SKILL_DIR(), relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  };

  it('pins the caps the VS Code twin shares', () => {
    const source = fs.readFileSync(new URL('./skill-files.ts', import.meta.url), 'utf8');
    expect(source).toContain('createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 })');
    const vscodeSource = fs.readFileSync(
      new URL('../../../../vscode/src/opencodeConfig.ts', import.meta.url),
      'utf8',
    );
    expect(vscodeSource).toContain('createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 })');
  });

  it('lists supporting files under the caps, excluding SKILL.md, without truncation', async () => {
    writeSupporting('SKILL.md', STANDARD_MD);
    writeSupporting(path.join('references', 'guide.md'), '# Guide');
    writeSupporting('notes.txt', 'notes');

    const result = await listSkillSupportingFiles(SKILL_DIR());

    expect(result.truncated).toBe(false);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      'notes.txt',
      path.join('references', 'guide.md'),
    ]);
    expect(result.files.find((file) => file.name === 'guide.md')).toEqual({
      name: 'guide.md',
      path: path.join('references', 'guide.md'),
      fullPath: path.join(SKILL_DIR(), 'references', 'guide.md'),
    });
  });

  it('returns an empty, untruncated listing for a missing skill directory', async () => {
    expect(await listSkillSupportingFiles(path.join(FIXTURE_DIR, 'nope'))).toEqual({
      files: [],
      truncated: false,
    });
  });

  it('stops at the directory cap and keeps the files found before it', async () => {
    writeSupporting('SKILL.md', STANDARD_MD);
    // One file per leaf: every visited leaf contributes exactly one file, so
    // the count is deterministic whatever order readdir returns the leaves.
    const leafCount = SKILL_SUPPORTING_FILES_MAX_DIRECTORIES + 10;
    for (let i = 0; i < leafCount; i += 1) {
      writeSupporting(path.join(`d${String(i).padStart(4, '0')}`, 'note.txt'));
    }

    const result = await listSkillSupportingFiles(SKILL_DIR());

    // The root plus MAX - 1 leaves are visited.
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(SKILL_SUPPORTING_FILES_MAX_DIRECTORIES - 1);
  }, 60_000);

  it('returns complete results for a tree exactly at the directory cap', async () => {
    writeSupporting('SKILL.md', STANDARD_MD);
    const leafCount = SKILL_SUPPORTING_FILES_MAX_DIRECTORIES - 1;
    for (let i = 0; i < leafCount; i += 1) {
      fs.mkdirSync(path.join(SKILL_DIR(), `d${String(i).padStart(4, '0')}`), { recursive: true });
    }
    writeSupporting(path.join('d0000', 'note.txt'));

    const result = await listSkillSupportingFiles(SKILL_DIR());

    expect(result.truncated).toBe(false);
    expect(result.files.map((file) => file.path)).toEqual([path.join('d0000', 'note.txt')]);
  }, 60_000);

  it('stops at the file cap and keeps the files collected before it', async () => {
    writeSupporting('SKILL.md', STANDARD_MD);
    const fileCount = SKILL_SUPPORTING_FILES_MAX_FILES + 10;
    for (let i = 0; i < fileCount; i += 1) {
      writeSupporting(`f${String(i).padStart(4, '0')}.txt`);
    }

    const result = await listSkillSupportingFiles(SKILL_DIR());

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(SKILL_SUPPORTING_FILES_MAX_FILES);
  }, 60_000);

  it('returns complete results for a tree exactly at the file cap', async () => {
    writeSupporting('SKILL.md', STANDARD_MD);
    for (let i = 0; i < SKILL_SUPPORTING_FILES_MAX_FILES; i += 1) {
      writeSupporting(`f${String(i).padStart(4, '0')}.txt`);
    }

    const result = await listSkillSupportingFiles(SKILL_DIR());

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(SKILL_SUPPORTING_FILES_MAX_FILES);
  }, 60_000);
});
