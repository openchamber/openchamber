import { describe, expect, it } from 'vitest';

import { createTerminalShellResolver, getTerminalShellLoginArgs } from './shells.js';

const createResolver = ({ platform = 'linux', env = {}, augmentedPath = '/augmented/bin', executables = [] } = {}) => {
  const available = new Set(executables);
  const path = {
    delimiter: platform === 'win32' ? ';' : ':',
    extname: (value) => /\.[^./\\]+$/.exec(value)?.[0] ?? '',
    join: (...parts) => parts.join(platform === 'win32' ? '\\' : '/'),
  };
  const searches = [];
  return {
    searches,
    resolver: createTerminalShellResolver({
      fs: { promises: { readFile: async () => '' } },
      path,
      platform,
      env,
      buildAugmentedPath: () => augmentedPath,
      searchPathFor: (name, searchPath) => {
        searches.push([name, searchPath]);
        const suffixes = platform === 'win32' ? ['', '.exe'] : [''];
        for (const suffix of suffixes) {
          const match = [...available].find((candidate) => candidate.toLowerCase().endsWith(`${platform === 'win32' ? '\\' : '/'}${name}${suffix}`.toLowerCase()));
          if (match) return match;
        }
        return null;
      },
      isExecutable: (candidate) => available.has(candidate),
    }),
  };
};

describe('terminal shell resolver', () => {
  it('discovers shells from the augmented PTY PATH', async () => {
    const { resolver, searches } = createResolver({ executables: ['/augmented/bin/fish'] });

    await expect(resolver.list()).resolves.toContainEqual({ id: 'fish', name: 'fish', executable: '/augmented/bin/fish', supportsLogin: true });
    expect(searches).toContainEqual(['fish', '/augmented/bin']);
  });

  it('discovers supported PATH-installed shells on Windows', async () => {
    const { resolver } = createResolver({
      platform: 'win32',
      augmentedPath: 'C:\\Tools',
      executables: ['C:\\Tools\\bash.exe', 'C:\\Tools\\nu.exe'],
    });

    await expect(resolver.list()).resolves.toEqual(expect.arrayContaining([
      { id: 'bash', name: 'bash', executable: 'C:\\Tools\\bash.exe', supportsLogin: true },
      { id: 'nu', name: 'nu', executable: 'C:\\Tools\\nu.exe', supportsLogin: true },
    ]));
  });

  it('uses environment overrides before platform defaults for auto', async () => {
    const { resolver } = createResolver({
      env: { OPENCHAMBER_TERMINAL_SHELL: '/custom/zsh', SHELL: '/bin/bash' },
      executables: ['/custom/zsh', '/bin/bash'],
    });

    await expect(resolver.resolve('auto')).resolves.toEqual({ id: 'auto', executables: ['/custom/zsh', '/bin/bash'] });
  });

  it('uses only known platform-safe login arguments', () => {
    expect(getTerminalShellLoginArgs('/bin/bash', 'linux')).toEqual(['-l']);
    expect(getTerminalShellLoginArgs('/opt/homebrew/bin/fish', 'darwin')).toEqual(['--login']);
    expect(getTerminalShellLoginArgs('/usr/bin/nu', 'linux')).toEqual(['--login']);
    expect(getTerminalShellLoginArgs('/usr/bin/pwsh', 'linux')).toEqual(['-Login']);
    expect(getTerminalShellLoginArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBeNull();
    expect(getTerminalShellLoginArgs('/bin/dash', 'linux')).toBeNull();
  });
});
