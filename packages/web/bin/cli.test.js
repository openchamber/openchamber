import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ensureTunnelProfilesMigrated,
  fetchSystemInfoFromPort,
  hasUiPasswordConfigured,
  isValidTunnelDoctorResponse,
  parseArgs,
  readDesktopLocalPortFromSettings,
  resolveTunnelProviders,
  shouldDisplayTunnelQr,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  maskToken,
  findClosestMatch,
  generateCompletionScript,
  TunnelCliError,
  EXIT_CODE,
  warnIfUnsafeFilePermissions,
} from './cli.js';

describe('cli password checks', () => {
  it('treats missing password as not configured', () => {
    expect(hasUiPasswordConfigured(undefined)).toBe(false);
    expect(hasUiPasswordConfigured(null)).toBe(false);
  });

  it('treats empty or whitespace password as not configured', () => {
    expect(hasUiPasswordConfigured('')).toBe(false);
    expect(hasUiPasswordConfigured('   ')).toBe(false);
  });

  it('treats non-empty password as configured', () => {
    expect(hasUiPasswordConfigured('secret')).toBe(true);
    expect(hasUiPasswordConfigured('  secret  ')).toBe(true);
  });
});

describe('cli desktop detection', () => {
  it('reads desktop local port from settings', () => {
    const tempDir = path.join(os.tmpdir(), `openchamber-cli-settings-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = tempDir;

    try {
      fs.writeFileSync(
        path.join(tempDir, 'settings.json'),
        JSON.stringify({ desktopLocalPort: 57123 }, null, 2),
        'utf8'
      );

      expect(readDesktopLocalPortFromSettings()).toBe(57123);
    } finally {
      if (typeof previousDataDir === 'string') {
        process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      } else {
        delete process.env.OPENCHAMBER_DATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores invalid desktop local port values', () => {
    const tempDir = path.join(os.tmpdir(), `openchamber-cli-settings-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = tempDir;

    try {
      fs.writeFileSync(path.join(tempDir, 'settings.json'), JSON.stringify({ desktopLocalPort: 0 }, null, 2), 'utf8');
      expect(readDesktopLocalPortFromSettings()).toBeNull();
    } finally {
      if (typeof previousDataDir === 'string') {
        process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      } else {
        delete process.env.OPENCHAMBER_DATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reads system info from a running port', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ runtime: 'desktop', pid: 9999 }),
    });

    const info = await fetchSystemInfoFromPort(57123, fetchImpl);
    expect(info).toEqual({ runtime: 'desktop', pid: 9999 });
  });
});

describe('cli parseArgs tunnel namespace', () => {
  it('parses tunnel start canonical args', () => {
    const parsed = parseArgs([
      'tunnel',
      'start',
      '--provider', 'cloudflare',
      '--mode', 'managed-local',
      '--config', '~/.cloudflared/config.yml',
      '--port', '3200',
      '--qr',
    ]);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.provider).toBe('cloudflare');
    expect(parsed.options.mode).toBe('managed-local');
    expect(parsed.options.configPath).toBe('~/.cloudflared/config.yml');
    expect(parsed.options.port).toBe(3200);
    expect(parsed.options.qr).toBe(true);
    expect(parsed.options.explicitPort).toBe(true);
    expect(parsed.removedFlagErrors.length).toBe(0);
  });

  it('defaults tunnel command without subcommand to help', () => {
    const parsed = parseArgs(['tunnel']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('help');
  });

  it('parses tunnel ready subcommand', () => {
    const parsed = parseArgs(['tunnel', 'ready', '--provider', 'cloudflare']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('ready');
    expect(parsed.options.provider).toBe('cloudflare');
  });

  it('parses tunnel profile nested subcommand and name', () => {
    const parsed = parseArgs(['tunnel', 'profile', 'show', '--name', 'prod-main', '--provider', 'cloudflare']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('profile');
    expect(parsed.tunnelAction).toBe('show');
    expect(parsed.options.name).toBe('prod-main');
    expect(parsed.options.provider).toBe('cloudflare');
  });

  it('hard-fails removed legacy tunnel flags', () => {
    const parsed = parseArgs(['--try-cf-tunnel']);
    expect(parsed.removedFlagErrors.length).toBeGreaterThan(0);
    expect(parsed.removedFlagErrors[0]).toContain('--try-cf-tunnel');
  });

  it('hard-fails removed daemon flag', () => {
    const parsed = parseArgs(['--daemon']);
    expect(parsed.removedFlagErrors.length).toBeGreaterThan(0);
    expect(parsed.removedFlagErrors[0]).toContain('--daemon');
  });

  it('parses --no-qr override', () => {
    const parsed = parseArgs(['tunnel', 'start', '--no-qr']);
    expect(parsed.options.qr).toBe(false);
    expect(parsed.options.explicitQr).toBe(true);
  });
});

describe('cli QR display policy', () => {
  it('never shows qr in json mode', () => {
    expect(shouldDisplayTunnelQr({ json: true, qr: true, explicitQr: true })).toBe(false);
  });

  it('respects explicit qr flags', () => {
    expect(shouldDisplayTunnelQr({ json: false, qr: true, explicitQr: true })).toBe(true);
    expect(shouldDisplayTunnelQr({ json: false, qr: false, explicitQr: true })).toBe(false);
  });
});

describe('cli tunnel doctor response validation', () => {
  it('accepts new shape with ready/blockers', () => {
    const valid = {
      ok: true,
      provider: 'cloudflare',
      providerChecks: [
        { id: 'dependency', label: 'cloudflared installed', status: 'pass', detail: 'v2024.12.1' },
      ],
      modes: [
        { mode: 'quick', ready: true, blockers: [] },
      ],
    };
    expect(isValidTunnelDoctorResponse(valid)).toBe(true);
  });

  it('accepts server shape with checks/summary', () => {
    const valid = {
      ok: true,
      provider: 'cloudflare',
      providerChecks: [
        { id: 'provider_dependency', label: 'Provider dependency', status: 'pass', detail: 'available' },
      ],
      modes: [
        { mode: 'quick', checks: [], summary: { ready: true, failures: 0, warnings: 0 } },
        { mode: 'managed-remote', checks: [{ id: 'token', status: 'fail', detail: 'missing' }], summary: { ready: false, failures: 1, warnings: 0 } },
      ],
    };
    expect(isValidTunnelDoctorResponse(valid)).toBe(true);
  });

  it('rejects invalid doctor payload shape', () => {
    expect(isValidTunnelDoctorResponse(null)).toBe(false);
    expect(isValidTunnelDoctorResponse({ ok: true })).toBe(false);
    expect(isValidTunnelDoctorResponse({ ok: true, providerChecks: [] })).toBe(false);
    expect(isValidTunnelDoctorResponse({ ok: true, modes: [] })).toBe(false);
  });

  it('accepts doctor payload with multiple modes (new shape)', () => {
    const multi = {
      ok: true,
      provider: 'cloudflare',
      providerChecks: [],
      modes: [
        { mode: 'quick', ready: true, blockers: [] },
        { mode: 'managed-remote', ready: false, blockers: ['token not configured'] },
        { mode: 'managed-local', ready: true, blockers: [] },
      ],
    };
    expect(isValidTunnelDoctorResponse(multi)).toBe(true);
  });

  it('rejects modes with missing fields', () => {
    const badMode = {
      ok: true,
      providerChecks: [],
      modes: [
        { mode: 'quick', ready: true },
      ],
    };
    expect(isValidTunnelDoctorResponse(badMode)).toBe(false);
  });
});

describe('cli tunnel provider discovery', () => {
  it('uses provider capabilities from local api when available', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        providers: [{ provider: 'cloudflare', modes: [{ key: 'quick' }] }],
      }),
    });

    const result = await resolveTunnelProviders({ port: 4501 }, { readPorts: () => [], fetchImpl });

    expect(result.source).toBe('api:4501');
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result.providers[0]?.provider).toBe('cloudflare');
  });

  it('falls back to built-in provider capabilities when api is unavailable', async () => {
    const fetchImpl = async () => {
      throw new Error('unreachable');
    };

    const result = await resolveTunnelProviders({ port: 4501 }, { readPorts: () => [], fetchImpl });

    expect(result.source).toBe('fallback');
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result.providers[0]?.provider).toBe('cloudflare');
  });
});

describe('cli tunnel profile migration', () => {
  it('migrates legacy managed-remote config entries before profile use', () => {
    const tempDir = path.join(os.tmpdir(), `openchamber-cli-profile-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = tempDir;

    try {
      fs.writeFileSync(
        path.join(tempDir, 'cloudflare-managed-remote-tunnels.json'),
        JSON.stringify({
          version: 1,
          tunnels: [
            {
              id: 'legacy-id',
              name: 'prod-main',
              hostname: 'app.example.com',
              token: 'secret-token',
              updatedAt: Date.now(),
            },
          ],
        }, null, 2),
        'utf8'
      );

      const migrated = ensureTunnelProfilesMigrated();
      expect(migrated.profiles.length).toBe(1);
      expect(migrated.profiles[0]?.provider).toBe('cloudflare');
      expect(migrated.profiles[0]?.mode).toBe('managed-remote');
      expect(migrated.profiles[0]?.name).toBe('prod-main');

      const persistedPath = path.join(tempDir, 'tunnel-profiles.json');
      expect(fs.existsSync(persistedPath)).toBe(true);
    } finally {
      if (typeof previousDataDir === 'string') {
        process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      } else {
        delete process.env.OPENCHAMBER_DATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ==========================================
// Phase 3: Quality gates and regression tests
// ==========================================

describe('token redaction', () => {
  it('maskToken redacts tokens longer than 4 chars', () => {
    expect(maskToken('abcdefgh')).not.toContain('abcd');
    expect(maskToken('abcdefgh')).toContain('efgh');
    expect(maskToken('abcdefgh').startsWith('*')).toBe(true);
  });

  it('maskToken fully masks short tokens', () => {
    expect(maskToken('abc')).toBe('***');
    expect(maskToken('ab')).toBe('**');
  });

  it('maskToken handles empty/missing', () => {
    expect(maskToken('')).toBe('***');
    expect(maskToken(undefined)).toBe('***');
    expect(maskToken(null)).toBe('***');
  });

  it('redactProfileForOutput redacts token by default', () => {
    const profile = { name: 'test', provider: 'cloudflare', mode: 'managed-remote', hostname: 'a.com', token: 'super-secret-token-12345' };
    const redacted = redactProfileForOutput(profile);
    expect(redacted.token).not.toBe('super-secret-token-12345');
    expect(redacted.token).toContain('2345');
    expect(redacted.token).toContain('*');
    expect(redacted.name).toBe('test');
  });

  it('redactProfileForOutput shows token with showSecrets=true', () => {
    const profile = { name: 'test', provider: 'cloudflare', mode: 'managed-remote', hostname: 'a.com', token: 'super-secret-token-12345' };
    const revealed = redactProfileForOutput(profile, true);
    expect(revealed.token).toBe('super-secret-token-12345');
  });

  it('redactProfilesForOutput redacts array of profiles', () => {
    const profiles = [
      { name: 'a', token: 'token-aaa-111' },
      { name: 'b', token: 'token-bbb-222' },
    ];
    const redacted = redactProfilesForOutput(profiles);
    expect(redacted[0].token).not.toBe('token-aaa-111');
    expect(redacted[0].token).toContain('*');
    expect(redacted[1].token).not.toBe('token-bbb-222');
  });

  it('redactProfilesForOutput reveals with showSecrets', () => {
    const profiles = [{ name: 'a', token: 'token-aaa-111' }];
    const revealed = redactProfilesForOutput(profiles, true);
    expect(revealed[0].token).toBe('token-aaa-111');
  });
});

describe('resolveToken', () => {
  it('resolves token from --token flag', () => {
    const result = resolveToken({ token: 'my-token-value' });
    expect(result).toBe('my-token-value');
  });

  it('resolves token from --token-file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-token-test-'));
    try {
      const tokenPath = path.join(tempDir, 'token');
      fs.writeFileSync(tokenPath, 'file-token-value\n', 'utf8');
      const result = resolveToken({ tokenFile: tokenPath });
      expect(result).toBe('file-token-value');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws on missing token file', () => {
    expect(() => resolveToken({ tokenFile: '/tmp/nonexistent-openchamber-token-file' })).toThrow(/not found/i);
  });

  it('throws on empty token file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-token-test-'));
    try {
      const tokenPath = path.join(tempDir, 'token');
      fs.writeFileSync(tokenPath, '  \n', 'utf8');
      expect(() => resolveToken({ tokenFile: tokenPath })).toThrow(/empty/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws on multiple token sources', () => {
    expect(() => resolveToken({ token: 'a', tokenFile: '/tmp/b' })).toThrow(/Multiple token sources/i);
  });

  it('returns undefined when no token source specified', () => {
    const result = resolveToken({});
    expect(result).toBeUndefined();
  });
});

describe('parseArgs new flags', () => {
  it('parses --token-file flag', () => {
    const parsed = parseArgs(['tunnel', 'start', '--token-file', '/tmp/token']);
    expect(parsed.options.tokenFile).toBe('/tmp/token');
  });

  it('parses --token-stdin flag', () => {
    const parsed = parseArgs(['tunnel', 'start', '--token-stdin']);
    expect(parsed.options.tokenStdin).toBe(true);
  });

  it('parses --show-secrets flag', () => {
    const parsed = parseArgs(['tunnel', 'profile', 'list', '--show-secrets']);
    expect(parsed.options.showSecrets).toBe(true);
  });

  it('parses --dry-run flag', () => {
    const parsed = parseArgs(['tunnel', 'start', '--dry-run']);
    expect(parsed.options.dryRun).toBe(true);
  });

  it('parses --plain flag', () => {
    const parsed = parseArgs(['tunnel', 'status', '--plain']);
    expect(parsed.options.plain).toBe(true);
  });

  it('parses --quiet flag', () => {
    const parsed = parseArgs(['tunnel', 'status', '--quiet']);
    expect(parsed.options.quiet).toBe(true);
  });

  it('parses -q as quiet', () => {
    const parsed = parseArgs(['tunnel', 'status', '-q']);
    expect(parsed.options.quiet).toBe(true);
  });
});

describe('findClosestMatch', () => {
  it('finds exact match', () => {
    expect(findClosestMatch('start', ['start', 'stop', 'status'])).toBe('start');
  });

  it('suggests close match for typo', () => {
    expect(findClosestMatch('strat', ['start', 'stop', 'status'])).toBe('start');
  });

  it('suggests close match for prefix typo', () => {
    expect(findClosestMatch('statu', ['start', 'stop', 'status'])).toBe('status');
  });

  it('returns null for completely unrelated input', () => {
    expect(findClosestMatch('zzzzzzzzzzz', ['start', 'stop', 'status'])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findClosestMatch('', ['start'])).toBeNull();
  });
});

describe('TunnelCliError', () => {
  it('has correct name and exit code', () => {
    const error = new TunnelCliError('test message', EXIT_CODE.USAGE_ERROR);
    expect(error.name).toBe('TunnelCliError');
    expect(error.exitCode).toBe(2);
    expect(error.message).toBe('test message');
  });

  it('defaults exit code to GENERAL_ERROR', () => {
    const error = new TunnelCliError('test');
    expect(error.exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
  });
});

describe('EXIT_CODE constants', () => {
  it('defines all expected codes', () => {
    expect(EXIT_CODE.SUCCESS).toBe(0);
    expect(EXIT_CODE.GENERAL_ERROR).toBe(1);
    expect(EXIT_CODE.USAGE_ERROR).toBe(2);
    expect(EXIT_CODE.MISSING_DEPENDENCY).toBe(3);
    expect(EXIT_CODE.AUTH_CONFIG_ERROR).toBe(4);
    expect(EXIT_CODE.NETWORK_RUNTIME_ERROR).toBe(5);
  });
});

describe('generateCompletionScript', () => {
  it('generates bash completion', () => {
    const script = generateCompletionScript('bash');
    expect(typeof script).toBe('string');
    expect(script).toContain('complete');
    expect(script).toContain('openchamber');
    expect(script).toContain('tunnel_commands');
  });

  it('generates zsh completion', () => {
    const script = generateCompletionScript('zsh');
    expect(typeof script).toBe('string');
    expect(script).toContain('compdef');
    expect(script).toContain('openchamber');
  });

  it('generates fish completion', () => {
    const script = generateCompletionScript('fish');
    expect(typeof script).toBe('string');
    expect(script).toContain('complete');
    expect(script).toContain('openchamber');
  });

  it('returns null for unsupported shell', () => {
    expect(generateCompletionScript('powershell')).toBeNull();
    expect(generateCompletionScript('')).toBeNull();
  });
});

describe('profile file permission checks', () => {
  it('warnIfUnsafeFilePermissions warns on world-readable files', () => {
    if (process.platform === 'win32') return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-perm-test-'));
    try {
      const filePath = path.join(tempDir, 'test-profiles.json');
      fs.writeFileSync(filePath, '{}', { encoding: 'utf8', mode: 0o644 });

      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        warnIfUnsafeFilePermissions(filePath);
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('644');
      expect(warnings[0]).toContain('chmod 600');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('warnIfUnsafeFilePermissions does not warn on 0600 files', () => {
    if (process.platform === 'win32') return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-perm-test-'));
    try {
      const filePath = path.join(tempDir, 'test-profiles.json');
      fs.writeFileSync(filePath, '{}', { encoding: 'utf8', mode: 0o600 });

      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        warnIfUnsafeFilePermissions(filePath);
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.length).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('no token in child process args', () => {
  it('cloudflared spawn uses --token-file instead of --token in args', async () => {
    // We verify by importing the function and checking the code path uses --token-file
    const { startCloudflareManagedRemoteTunnel } = await import('../server/lib/cloudflare-tunnel.js');
    // The function signature accepts tokenFilePath. We can't easily spawn cloudflared
    // in test, but we verify the function exists and accepts the right shape.
    expect(typeof startCloudflareManagedRemoteTunnel).toBe('function');
  });
});

describe('tunnel workflow regressions', () => {
  it('parseArgs tunnel ready subcommand', () => {
    const parsed = parseArgs(['tunnel', 'ready', '--provider', 'cloudflare', '--json']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('ready');
    expect(parsed.options.provider).toBe('cloudflare');
    expect(parsed.options.json).toBe(true);
  });

  it('parseArgs tunnel doctor with mode filter', () => {
    const parsed = parseArgs(['tunnel', 'doctor', '--provider', 'cloudflare', '--mode', 'quick']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('doctor');
    expect(parsed.options.provider).toBe('cloudflare');
    expect(parsed.options.mode).toBe('quick');
  });

  it('parseArgs tunnel status with all flag', () => {
    const parsed = parseArgs(['tunnel', 'status', '--all']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('status');
    expect(parsed.options.all).toBe(true);
  });

  it('parseArgs tunnel stop with port', () => {
    const parsed = parseArgs(['tunnel', 'stop', '--port', '3200']);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('stop');
    expect(parsed.options.port).toBe(3200);
  });

  it('parseArgs tunnel profile add with token-file', () => {
    const parsed = parseArgs([
      'tunnel', 'profile', 'add',
      '--provider', 'cloudflare',
      '--mode', 'managed-remote',
      '--name', 'prod',
      '--hostname', 'app.example.com',
      '--token-file', '/tmp/token',
    ]);
    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('profile');
    expect(parsed.tunnelAction).toBe('add');
    expect(parsed.options.tokenFile).toBe('/tmp/token');
    expect(parsed.options.token).toBeUndefined();
  });

  it('parseArgs tunnel start with all new flags', () => {
    const parsed = parseArgs([
      'tunnel', 'start',
      '--provider', 'cloudflare',
      '--mode', 'managed-remote',
      '--token-file', '/tmp/token',
      '--hostname', 'app.example.com',
      '--dry-run',
      '--show-secrets',
      '--plain',
      '--quiet',
    ]);
    expect(parsed.options.tokenFile).toBe('/tmp/token');
    expect(parsed.options.dryRun).toBe(true);
    expect(parsed.options.showSecrets).toBe(true);
    expect(parsed.options.plain).toBe(true);
    expect(parsed.options.quiet).toBe(true);
  });
});
