import { describe, expect, it } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import { assertAuthenticatedNetworkExposure, parseArgs, buildWindowsStartupActionCommand, buildWindowsRegisterScheduledTaskScript } from './cli.js';

describe('cli args', () => {
  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses explicit connect-url server overrides', () => {
    const parsed = parseArgs(['connect-url', '--server', 'https://openchamber.example.com', '--port', '3002']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.server).toBe('https://openchamber.example.com');
    expect(parsed.options.port).toBe(3002);
  });

  it('parses connect-url server-url alias', () => {
    const parsed = parseArgs(['connect-url', '--server-url=http://homebridge:3002']);

    expect(parsed.options.server).toBe('http://homebridge:3002');
  });

  it('parses connect-url api-only help', () => {
    const parsed = parseArgs(['connect-url', '--api-only', '--help']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses startup api-only option', () => {
    const parsed = parseArgs(['startup', 'enable', '--api-only', '--port', '3002']);

    expect(parsed.command).toBe('startup');
    expect(parsed.startupAction).toBe('enable');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.port).toBe(3002);
  });

  it('parses tunnel auto-start server options', () => {
    const parsed = parseArgs(['tunnel', 'start', '--port', '3002', '--api-only', '--lan', '--ui-password', 'secret']);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.uiPassword).toBe('secret');
  });

  it('maps --lan to wildcard bind host', () => {
    const parsed = parseArgs(['serve', '--lan', '--port', '3002']);

    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.lan).toBe(true);
  });

  it('supports --hostname as top-level bind alias', () => {
    const parsed = parseArgs(['serve', '--hostname', '0.0.0.0']);

    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('keeps --hostname for tunnel commands', () => {
    const parsed = parseArgs(['tunnel', 'start', '--hostname', 'app.example.com']);

    expect(parsed.options.hostname).toBe('app.example.com');
    expect(parsed.options.host).toBeUndefined();
  });
});

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
    process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('cli entry detection', () => {
  const modulePath = '/tmp/openchamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/openchamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/openchamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'openchamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('Windows startup scheduled task builder', () => {
  it('registers a per-user task that does not require elevation', () => {
    const actionCommand = buildWindowsStartupActionCommand({ port: 3000 });
    const script = buildWindowsRegisterScheduledTaskScript({
      taskName: 'dev.openchamber.web',
      actionCommand,
    });

    expect(script).toContain('Register-ScheduledTask -TaskName');
    expect(script).toContain("'dev.openchamber.web'");
    expect(script).toContain('LogonType Interactive');
    expect(script).toContain('RunLevel Limited');
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('ExecutionTimeLimit ([TimeSpan]::Zero)');
  });

  it('does not use the legacy schtasks.exe /SC ONLOGON path', () => {
    const script = buildWindowsRegisterScheduledTaskScript({
      taskName: 'dev.openchamber.web',
      actionCommand: 'noop',
    });

    expect(script).not.toMatch(/schtasks/i);
    expect(script).not.toMatch(/\/SC\s+ONLOGON/i);
    expect(script).not.toMatch(/\/TR\b/);
  });

  it('binds the task to the current user via interactive principal', () => {
    const script = buildWindowsRegisterScheduledTaskScript({
      taskName: 'dev.openchamber.web',
      actionCommand: 'noop',
    });

    expect(script).toContain('[Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).toContain('New-ScheduledTaskPrincipal -UserId $u');
  });

  it('wraps the action as a powershell.exe command that loads env and serves', () => {
    const actionCommand = buildWindowsStartupActionCommand({ port: 3000 });
    const script = buildWindowsRegisterScheduledTaskScript({
      taskName: 'dev.openchamber.web',
      actionCommand,
    });

    expect(script).toContain("New-ScheduledTaskAction -Execute 'powershell.exe'");
    expect(script).toContain('-NoProfile -ExecutionPolicy Bypass -Command');
  });
});

describe('Windows startup action command', () => {
  it('loads the persisted startup env then runs node serve with the port', () => {
    const command = buildWindowsStartupActionCommand({ port: 3000 });

    expect(command).toContain('Test-Path $envFile');
    expect(command).toContain('Get-Content $envFile');
    expect(command).toContain('SetEnvironmentVariable');
    expect(command).toContain("'--port', '3000'");
    expect(command).toContain("'serve'");
    expect(command).toContain("'--foreground'");
  });

  it('references node to launch the cli entrypoint', () => {
    const command = buildWindowsStartupActionCommand({ port: 4000 });

    expect(command).toMatch(/&\s+'[^']+'[^;]*'serve'/);
  });
});
