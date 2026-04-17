import { describe, expect, it } from 'bun:test';

import {
  createPtySession,
  getTerminalShellCandidates,
  normalizeTerminalShellPreference,
} from './session.js';

describe('terminal session helpers', () => {
  it('normalizes unknown shell preferences to default', () => {
    expect(normalizeTerminalShellPreference('powershell')).toBe('powershell');
    expect(normalizeTerminalShellPreference('nope')).toBe('default');
  });

  it('prioritizes powershell on windows when requested', () => {
    const resolved = getTerminalShellCandidates({
      preference: 'powershell',
      env: { SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe' },
      pathModule: { join: (...parts) => parts.join('/').replaceAll('\\', '/').replace('C:/Windows', 'C:\\Windows') },
      isExecutable: (candidate) => candidate === 'pwsh.exe' || candidate === 'cmd.exe',
      searchPathFor: (candidate) => candidate,
      platform: 'win32',
    });

    expect(resolved[0]).toBe('pwsh.exe');
  });

  it('enables conpty for node-pty on windows', () => {
    let captured = null;
    const result = createPtySession({
      backend: 'node-pty',
      spawn(shell, args, options) {
        captured = { shell, args, options };
        return { shell, args, options };
      },
    }, {
      cwd: 'C:\\Users\\Test',
      env: {},
      shellPreference: 'cmd',
      pathModule: { join: (...parts) => parts.join('\\') },
      isExecutable: (candidate) => candidate === 'cmd.exe',
      searchPathFor: (candidate) => candidate,
      platform: 'win32',
    });

    expect(result.usedConpty).toBe(true);
    expect(captured?.options?.useConpty).toBe(true);
  });
});
