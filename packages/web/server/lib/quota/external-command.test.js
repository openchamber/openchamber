import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import { fetchCommandQuota, parseUsageCommandOutput, parseUsageProviderCommands } from './external-command.js';

describe('external usage command', () => {
  test('accepts versioned non-empty argv arrays', () => {
    expect(parseUsageProviderCommands({ version: 1, commands: {
      codex: ['/usr/bin/helper', '--json'],
    } })).toEqual({ codex: ['/usr/bin/helper', '--json'] });
  });

  test('rejects malformed configuration instead of silently using built-in usage', () => {
    expect(() => parseUsageProviderCommands(null)).toThrow('invalid');
    expect(() => parseUsageProviderCommands({ version: 1, commands: { codex: [] } })).toThrow('invalid');
  });

  test('maps account windows and status into the quota contract', () => {
    const result = parseUsageCommandOutput({
      providerId: 'codex',
      providerName: 'Codex',
      stdout: JSON.stringify({
        version: 1,
        accounts: [{
          id: 'account-2',
          label: 'Work',
          email: 'w...@example.com',
          current: true,
          available: true,
          status: 'Active',
          planType: 'plus',
          credits: '0',
          limits: [{ name: '5h limit', windowMinutes: 300, usedPercent: 17, resetAtMs: 2_000_000_000_000 }],
        }],
      }),
    });

    expect(result).toMatchObject({ providerId: 'codex', providerName: 'Codex', ok: true, configured: true });
    expect(result.usage.accounts[0]).toMatchObject({
      id: 'account-2',
      label: 'Work',
      detail: 'w...@example.com',
      current: true,
      available: true,
      status: 'Active',
      planLabel: 'plus',
    });
    expect(result.usage.accounts[0].windows['5h']).toMatchObject({ usedPercent: 17, remainingPercent: 83, windowSeconds: 18_000 });
    expect(result.usage.accounts[0].windows.credits_balance.valueLabel).toBe('$0.00');
  });

  test('rejects unversioned output', () => {
    expect(() => parseUsageCommandOutput({
      providerId: 'codex',
      providerName: 'Codex',
      stdout: JSON.stringify({ accounts: [] }),
    })).toThrow('unsupported payload');
  });

  test('runs without a shell and passes the requested working directory', async () => {
    const directory = os.tmpdir();
    const script = `console.log(JSON.stringify({version:1,accounts:[{label:process.cwd(),limits:[{windowMinutes:300,usedPercent:1}]}]}))`;
    const result = await fetchCommandQuota({
      providerId: 'codex',
      providerName: 'Codex',
      command: [process.execPath, '-e', script],
      directory,
    });

    expect(result.usage.accounts[0].label).toBe(fs.realpathSync(directory));
  });

  test('returns a generic error instead of command stderr', async () => {
    await expect(fetchCommandQuota({
      providerId: 'codex',
      providerName: 'Codex',
      command: [process.execPath, '-e', 'console.error("secret"); process.exit(1)'],
    })).rejects.toThrow('Usage command failed');
  });
});
