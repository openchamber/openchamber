import { describe, expect, it } from 'bun:test';

import {
  isPathWithinDirectory,
  resolveTunnelConfigPath,
} from './types.js';

describe('tunnel config path normalization', () => {
  it('allows Windows home paths with different drive casing', () => {
    expect(isPathWithinDirectory(
      'c:\\Users\\Bohdan\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(true);
  });

  it('does not allow Windows sibling home directories', () => {
    expect(isPathWithinDirectory(
      'C:\\Users\\Bohdan2\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(false);
  });

  it('resolves Windows tilde paths inside the provided home directory', () => {
    expect(resolveTunnelConfigPath('~\\.cloudflared\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toBe('C:\\Users\\Bohdan\\.cloudflared\\config.yml');
  });

  it('rejects Windows paths outside the provided home directory', () => {
    expect(() => resolveTunnelConfigPath('C:\\Temp\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toThrow(/Config path must be within the home directory/);
  });
});
