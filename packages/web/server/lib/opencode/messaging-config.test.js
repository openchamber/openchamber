import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMessagingConfig, parseMessagingConfig, setMessagingConfig } from './messaging-config.js';

let tempDir;
let configPath;
let previousConfigEnv;
let previousHome;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-messaging-config-'));
  configPath = path.join(tempDir, 'custom-opencode.json');
  previousConfigEnv = process.env.OPENCODE_CONFIG;
  // Settings writes to OPENCODE_CONFIG when set, so the real user config stays untouched.
  process.env.OPENCODE_CONFIG = configPath;
  // Homedir-derived sources (the config layers' fallbacks and the legacy
  // ~/.opencode global) must not leak the machine's real OpenCode state
  // into these tests (#2309): pin HOME inside the temp dir.
  previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, 'home');
});

afterEach(() => {
  if (previousConfigEnv === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = previousConfigEnv;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getMessagingConfig', () => {
  it('returns null when the file has no messaging key', () => {
    writeJson(configPath, { model: 'openai/gpt-5' });
    expect(getMessagingConfig(null)).toEqual({ messaging: null, path: configPath, projectPath: null });
  });

  it('names the deepest project config that sets messaging', () => {
    writeJson(configPath, { model: 'openai/gpt-5' });
    const projectDir = path.join(tempDir, 'repo', 'app');
    writeJson(path.join(tempDir, 'repo', 'app', 'opencode.json'), { messaging: { session_start: '' } });
    writeJson(path.join(tempDir, 'repo', 'app', '.opencode', 'opencode.json'), { model: 'x' });
    expect(getMessagingConfig(projectDir).projectPath).toBe(path.join(projectDir, 'opencode.json'));
    expect(getMessagingConfig(path.join(tempDir, 'repo')).projectPath).toBeNull();
  });

  it('keeps the project override when OPENCODE_CONFIG sets messaging too', () => {
    writeJson(configPath, { messaging: { vars: { a: 'b' } } });
    const projectDir = path.join(tempDir, 'repo');
    writeJson(path.join(projectDir, 'opencode.json'), { messaging: { session_start: '' } });
    expect(getMessagingConfig(projectDir).projectPath).toBe(path.join(projectDir, 'opencode.json'));
  });

  it('does not lock the winning project file when Settings writes that file', () => {
    const projectDir = path.join(tempDir, 'repo', 'app');
    process.env.OPENCODE_CONFIG = path.join(projectDir, 'opencode.json');
    writeJson(process.env.OPENCODE_CONFIG, { messaging: { session_start: '' } });
    writeJson(path.join(tempDir, 'repo', 'opencode.json'), { messaging: { embedding: 'off' } });
    expect(getMessagingConfig(projectDir).projectPath).toBeNull();
  });

  it('ranks every .opencode config above direct configs, including deeper ones', () => {
    const projectDir = path.join(tempDir, 'repo', 'app');
    writeJson(configPath, { warming: false });
    writeJson(path.join(projectDir, 'opencode.jsonc'), { messaging: { search: { match: 'regex' } } });
    writeJson(path.join(tempDir, 'repo', '.opencode', 'opencode.json'), { messaging: { search: { match: 'exact' } } });
    expect(getMessagingConfig(projectDir).projectPath).toBe(path.join(tempDir, 'repo', '.opencode', 'opencode.json'));
  });

  it('includes config files above the worktree root', () => {
    const projectDir = path.join(tempDir, 'repo', 'app');
    fs.mkdirSync(path.join(tempDir, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(tempDir, 'opencode.json'), { messaging: { embedding: 'off' } });
    expect(getMessagingConfig(projectDir).projectPath).toBe(path.join(tempDir, 'opencode.json'));
  });
});

describe('setMessagingConfig', () => {
  it('writes the section, keeps the rest of the file, and reads it back', () => {
    writeJson(configPath, { model: 'openai/gpt-5' });
    const messaging = { presets: { review: 'Review {{topic}}' }, delivery: { direct: 'inbox' }, embedding: 'tiny' };

    expect(setMessagingConfig(messaging)).toEqual({ messaging, path: configPath, changed: true });
    expect(readJson(configPath)).toEqual({ model: 'openai/gpt-5', messaging });
    expect(getMessagingConfig(null).messaging).toEqual(messaging);
  });

  it('removes the key for null', () => {
    writeJson(configPath, { model: 'openai/gpt-5', messaging: { session_start: '' } });
    expect(setMessagingConfig(null)).toEqual({ messaging: null, path: configPath, changed: true });
    expect(readJson(configPath)).toEqual({ model: 'openai/gpt-5' });
  });

  it('leaves the file untouched when the value is already there', () => {
    writeJson(configPath, { messaging: { search: { match: 'hybrid' }, vars: { a: 'b', c: 'd' } } });
    const before = fs.statSync(configPath).mtimeMs;
    expect(setMessagingConfig({ vars: { c: 'd', a: 'b' }, search: { match: 'hybrid' } }).changed).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
    expect(fs.existsSync(`${configPath}.openchamber.backup`)).toBe(false);
    expect(setMessagingConfig(null).changed).toBe(true);
    expect(setMessagingConfig(null).changed).toBe(false);
  });
});

describe('parseMessagingConfig', () => {
  it('requires the messaging property and accepts null', () => {
    expect(parseMessagingConfig(undefined).error).toMatch(/required/);
    expect(parseMessagingConfig(null)).toEqual({ value: null });
  });

  it('accepts embedding as a tier name or as detailed settings', () => {
    expect(parseMessagingConfig({ embedding: 'step-up' })).toEqual({ value: { embedding: 'step-up' } });
    const embedding = {
      tier: 'off',
      pooling: 'mean',
      autostart: false,
      gpu_layers: 0,
      threads: 4,
      remote: { url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', key: '{env:OPENAI_API_KEY}', dimensions: 512 },
    };
    expect(parseMessagingConfig({ embedding })).toEqual({ value: { embedding } });
    expect(parseMessagingConfig({ embedding: '' }).error).toMatch(/^messaging\.embedding:/);
  });

  it('names the path of an unknown key', () => {
    expect(parseMessagingConfig({ topics: {} }).error).toBe('messaging.topics: unknown key');
    expect(parseMessagingConfig({ delivery: { group: 'wake' } }).error).toBe('messaging.delivery.group: unknown key');
    expect(parseMessagingConfig({ embedding: { remote: { url: 'u', model: 'm', token: 't' } } }).error)
      .toBe('messaging.embedding.remote.token: unknown key');
  });

  it('rejects a value outside an enum or of the wrong type', () => {
    expect(parseMessagingConfig({ delivery: { direct: 'loud' } }).error).toMatch(/^messaging\.delivery\.direct:/);
    expect(parseMessagingConfig({ search: { match: 'vector' } }).error).toMatch(/^messaging\.search\.match:/);
    expect(parseMessagingConfig({ embedding: { threads: 0 } }).error).toMatch(/^messaging\.embedding\.threads:/);
    expect(parseMessagingConfig({ embedding: { remote: { url: 'u' } } }).error).toMatch(/^messaging\.embedding\.remote\.model:/);
    expect(parseMessagingConfig({ presets: { a: 1 } }).error).toMatch(/^messaging\.presets\.a:/);
    expect(parseMessagingConfig([]).error).toMatch(/^messaging:/);
  });
});
