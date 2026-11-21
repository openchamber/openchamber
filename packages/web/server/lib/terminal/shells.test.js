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

  it('discovers a Windows PowerShell execution alias that cannot be statted', async () => {
    const alias = 'C:\\WindowsApps\\pwsh.exe';
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: {},
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\WindowsApps',
      searchPathFor: () => null,
      isExecutable: () => false,
      probePowerShell: async (file) => file === alias,
    });

    await expect(resolver.resolve('pwsh')).resolves.toEqual({ id: 'pwsh', executables: [alias] });
  });

  it('launches a probe only for a Windows Store alias, never for another unreadable pwsh', async () => {
    let probes = 0;
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: {},
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\Tools',
      searchPathFor: (name, directory) => `${directory}\\${name}.exe`,
      isExecutable: () => false,
      probePowerShell: async () => { probes++; return true; },
    });

    await expect(resolver.resolve('pwsh')).rejects.toThrow('not available');
    expect(probes).toBe(0);
  });

  it('probes the package-specific Store alias inside WindowsApps too', async () => {
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe';
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: { OPENCHAMBER_TERMINAL_SHELL: alias },
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\Tools',
      searchPathFor: () => null,
      isExecutable: () => false,
      probePowerShell: async (file) => file === alias,
    });

    await expect(resolver.resolve('pwsh')).resolves.toEqual({ id: 'pwsh', executables: [alias] });
  });

  it('keeps a bare pwsh that is executable as given when PATH has no match', async () => {
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: { OPENCHAMBER_TERMINAL_SHELL: 'pwsh' },
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
      buildAugmentedPath: () => 'C:\\Tools',
      searchPathFor: () => null,
      isExecutable: (candidate) => candidate === 'pwsh',
      probePowerShell: async () => false,
    });

    const auto = await resolver.resolve('auto');
    const first = [];
    for await (const executable of auto.executables) { first.push(executable); break; }
    expect(first).toEqual(['pwsh']);
  });

  it('respects PATH order and ignores aliases that fail their launch probe', async () => {
    const alias = 'C:\\WindowsApps\\pwsh.exe';
    const installed = 'C:\\Tools\\pwsh.exe';
    let status = 1;
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: {},
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\WindowsApps;C:\\Tools',
      searchPathFor: (_name, directory) => directory === 'C:\\Tools' ? installed : null,
      isExecutable: (file) => file === installed,
      probePowerShell: async () => status === 0,
    });

    await expect(resolver.resolve('pwsh')).resolves.toEqual({ id: 'pwsh', executables: [installed] });
    status = 0;
    await expect(resolver.resolve('pwsh')).resolves.toEqual({ id: 'pwsh', executables: [alias] });
  });

  it('honors an absolute alias override and probes each alias once per listing', async () => {
    const alias = 'C:\\WindowsApps\\pwsh.exe';
    let probes = 0;
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: { OPENCHAMBER_TERMINAL_SHELL: alias },
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\WindowsApps',
      searchPathFor: () => null,
      isExecutable: () => false,
      probePowerShell: async () => { probes++; return true; },
    });

    expect((await resolver.list())[0].executable).toBe(alias);
    expect(probes).toBe(1);
    const auto = await resolver.resolve('auto');
    expect(await Array.fromAsync(auto.executables)).toEqual([alias]);
  });

  it('defers the alias probe until auto needs its fallback and skips it for cmd', async () => {
    const cmd = 'C:\\Windows\\cmd.exe';
    const alias = 'C:\\WindowsApps\\pwsh.exe';
    let finishProbe;
    let probes = 0;
    const resolver = createTerminalShellResolver({
      platform: 'win32', env: { ComSpec: cmd },
      path: { delimiter: ';', join: (...parts) => parts.join('\\') },
      fs: { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
      buildAugmentedPath: () => 'C:\\WindowsApps',
      searchPathFor: () => null,
      isExecutable: (file) => file === cmd,
      probePowerShell: () => { probes++; return new Promise((resolve) => { finishProbe = resolve; }); },
    });

    await expect(resolver.resolve('cmd')).resolves.toEqual({ id: 'cmd', executables: [cmd] });
    const auto = await resolver.resolve('auto');
    const iterator = auto.executables[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(cmd);
    expect(probes).toBe(0);
    const fallback = iterator.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(probes).toBe(1);
    finishProbe(true);
    expect((await fallback).value).toBe(alias);
    await iterator.return();
  });

  it('uses environment overrides before platform defaults for auto', async () => {
    const { resolver } = createResolver({
      env: { OPENCHAMBER_TERMINAL_SHELL: '/custom/zsh', SHELL: '/bin/bash' },
      executables: ['/custom/zsh', '/bin/bash'],
    });

    const auto = await resolver.resolve('auto');
    expect(auto.id).toBe('auto');
    expect(await Array.fromAsync(auto.executables)).toEqual(['/custom/zsh', '/bin/bash']);
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
