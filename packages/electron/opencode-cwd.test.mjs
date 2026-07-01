import { describe, expect, it } from 'vitest';

import { resolveManagedOpenCodeCwd } from './opencode-cwd.mjs';

describe('resolveManagedOpenCodeCwd', () => {
  it('defaults managed OpenCode cwd to the user home directory', () => {
    expect(resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' })).toBe('/Users/example');
  });

  it('preserves an explicit cwd override', () => {
    expect(resolveManagedOpenCodeCwd({
      env: { OPENCHAMBER_OPENCODE_CWD: '/tmp/opencode-cwd' },
      homedir: () => '/Users/example',
    })).toBe('/tmp/opencode-cwd');
  });

  it('ignores a blank cwd override', () => {
    expect(resolveManagedOpenCodeCwd({
      env: { OPENCHAMBER_OPENCODE_CWD: '   ' },
      homedir: () => '/Users/example',
    })).toBe('/Users/example');
  });
});
