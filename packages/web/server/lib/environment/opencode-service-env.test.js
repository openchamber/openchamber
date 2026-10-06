import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
