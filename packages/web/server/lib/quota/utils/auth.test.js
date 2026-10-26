import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveConfigApiKey } from './auth.js';

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
});
