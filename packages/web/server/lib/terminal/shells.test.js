import { describe, expect, it } from 'vitest';

import * as shells from './shells.js';

const { createTerminalShellResolver, getTerminalShellLoginArgs } = shells;

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

  it('builds interactive shell launches by shell family', () => {
    const buildLaunch = shells.buildTerminalShellLaunch;

    expect(buildLaunch('/bin/bash', { mode: 'interactive', loginShell: true, platform: 'linux' })).toEqual({ executable: '/bin/bash', args: ['-l'] });
    expect(buildLaunch('/opt/homebrew/bin/fish', { mode: 'interactive', loginShell: true, platform: 'darwin' })).toEqual({ executable: '/opt/homebrew/bin/fish', args: ['--login'] });
    expect(buildLaunch('/usr/bin/nu', { mode: 'interactive', loginShell: true, platform: 'linux' })).toEqual({ executable: '/usr/bin/nu', args: ['--login'] });
    expect(buildLaunch('/usr/bin/pwsh', { mode: 'interactive', loginShell: true, platform: 'linux' })).toEqual({ executable: '/usr/bin/pwsh', args: ['-Login'] });
    expect(buildLaunch('C:\\Windows\\System32\\cmd.exe', { mode: 'interactive', loginShell: false, platform: 'win32' })).toEqual({ executable: 'C:\\Windows\\System32\\cmd.exe', args: [] });
  });

  it('builds command launches by shell family', () => {
    const buildLaunch = shells.buildTerminalShellLaunch;

    expect(buildLaunch('/bin/zsh', { mode: 'command', command: 'printf ready', loginShell: true, platform: 'linux' })).toEqual({ executable: '/bin/zsh', args: ['-l', '-i', '-c', 'printf ready'] });
    expect(buildLaunch('/opt/homebrew/bin/fish', { mode: 'command', command: 'echo ready', loginShell: true, platform: 'darwin' })).toEqual({ executable: '/opt/homebrew/bin/fish', args: ['--login', '-i', '-c', 'echo ready'] });
    expect(buildLaunch('/usr/bin/nu', { mode: 'command', command: 'ls', loginShell: true, platform: 'linux' })).toEqual({ executable: '/usr/bin/nu', args: ['--login', '-c', 'ls'] });
    expect(buildLaunch('/usr/bin/pwsh', { mode: 'command', command: 'Get-ChildItem', loginShell: true, platform: 'linux' })).toEqual({ executable: '/usr/bin/pwsh', args: ['-Login', '-Command', 'Get-ChildItem'] });
    expect(buildLaunch('C:\\Program Files\\PowerShell\\7\\pwsh.exe', { mode: 'command', command: 'Get-Date', loginShell: false, platform: 'win32' })).toEqual({ executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-Command', 'Get-Date'] });
    expect(buildLaunch('C:\\Windows\\System32\\cmd.exe', { mode: 'command', command: 'dir', loginShell: false, platform: 'win32' })).toEqual({ executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'dir'] });
  });

  it('rejects unsupported login and command combinations', () => {
    const buildLaunch = shells.buildTerminalShellLaunch;

    expect(() => buildLaunch('/bin/sh', { mode: 'interactive', loginShell: true, platform: 'linux' })).toThrow('does not support login mode');
    expect(() => buildLaunch('/bin/dash', { mode: 'command', command: 'pwd', loginShell: true, platform: 'linux' })).toThrow('does not support login mode');
    expect(() => buildLaunch('/bin/bash', { mode: 'command', command: '', loginShell: false, platform: 'linux' })).toThrow('Terminal command is required');
  });
});
