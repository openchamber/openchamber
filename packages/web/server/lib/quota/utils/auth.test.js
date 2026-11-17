import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readJsonFile, resolveConfigApiKey } from './auth.js';

describe('resolveConfigApiKey', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-config-key-'));
  const homeDir = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'zhipu-key'), 'home-token\n');
  fs.writeFileSync(path.join(configDir, 'key.txt'), 'config-token\n');
  const options = { configDir, homeDir, env: { ZHIPU_KEY: ' env-token ' } };

  it('reads {file:~/...} from the home directory', () => {
    expect(resolveConfigApiKey('{file:~/zhipu-key}', options)).toBe('home-token');
  });

  it('reads a relative {file:...} from the config directory and an absolute one as is', () => {
    expect(resolveConfigApiKey('{file:./key.txt}', options)).toBe('config-token');
    expect(resolveConfigApiKey('{file:key.txt}', options)).toBe('config-token');
    expect(resolveConfigApiKey(`{file:${path.join(homeDir, 'zhipu-key')}}`, options)).toBe('home-token');
  });

  it('reads {env:NAME}', () => {
    expect(resolveConfigApiKey('{env:ZHIPU_KEY}', options)).toBe('env-token');
  });

  it('never sends a reference that names nothing readable', () => {
    expect(resolveConfigApiKey('{file:~/missing}', options)).toBeNull();
    expect(resolveConfigApiKey('{env:MISSING}', options)).toBeNull();
  });

  it('keeps a plain key as it is', () => {
    expect(resolveConfigApiKey(' plain-key ', options)).toBe('plain-key');
  });

  it('answers null for an over-cap {file:} target instead of buffering it whole (#1645)', () => {
    fs.writeFileSync(path.join(configDir, 'big-key'), 'x'.repeat(128 * 1024));
    expect(resolveConfigApiKey('{file:./big-key}', options)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('answers null promptly for a FIFO {file:} target (#1645)', () => {
    const fifoPath = path.join(configDir, 'fifo-key');
    execFileSync('mkfifo', [fifoPath]);
    expect(resolveConfigApiKey('{file:./fifo-key}', options)).toBeNull();
  });
});

describe('readJsonFile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-read-json-'));

  it('parses a small JSON file and answers null for a missing one', () => {
    const filePath = path.join(root, 'credentials.json');
    fs.writeFileSync(filePath, JSON.stringify({ token: 'abc' }));
    expect(readJsonFile(filePath)).toEqual({ token: 'abc' });
    expect(readJsonFile(path.join(root, 'missing.json'))).toBeNull();
  });

  it('answers null for an over-cap file instead of parsing it whole (#1645)', () => {
    const filePath = path.join(root, 'big.json');
    fs.writeFileSync(filePath, JSON.stringify({ token: 'x'.repeat(1024 * 1024) }));
    expect(readJsonFile(filePath)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('answers null promptly for a FIFO instead of blocking (#1645)', () => {
    const fifoPath = path.join(root, 'accounts.json');
    execFileSync('mkfifo', [fifoPath]);
    expect(readJsonFile(fifoPath)).toBeNull();
  });
});
