import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOpenCodeServiceEnv } from './opencode-service-env.js';

describe('readOpenCodeServiceEnv', () => {
  let configDir;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-service-env-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('reads the variables `opencode service set env` stored', () => {
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ port: 49374, password: 'p', env: { API_KEY: 'k', 'bad name': 'x' } }));
    expect(readOpenCodeServiceEnv(configDir)).toEqual({ API_KEY: 'k' });
  });

  it('reads a missing, broken or unexpected file as no variables', () => {
    expect(readOpenCodeServiceEnv(configDir)).toEqual({});
    fs.writeFileSync(path.join(configDir, 'service.json'), '{ broken');
    expect(readOpenCodeServiceEnv(configDir)).toEqual({});
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ env: { A: 1 } }));
    expect(readOpenCodeServiceEnv(configDir)).toEqual({});
  });

  it('reads an over-cap valid file as no variables', () => {
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ env: { A: 'x'.repeat(1024 * 1024) } }));
    expect(readOpenCodeServiceEnv(configDir)).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', () => {
    const fifo = spawnSync('mkfifo', [path.join(configDir, 'service.json')]);
    expect(fifo.status).toBe(0);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { readOpenCodeServiceEnv } = await import(process.argv[1]); console.log(JSON.stringify(readOpenCodeServiceEnv(process.argv[2])));',
      new URL('./opencode-service-env.js', import.meta.url).href, configDir],
    { encoding: 'utf8', timeout: 3000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({});
  });
});
