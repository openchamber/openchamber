import { describe, expect, it, vi } from 'vitest';
import { readProcessInstance } from './process-instance.js';

const firstBoot = '11111111-1111-4111-8111-111111111111';
const secondBoot = '22222222-2222-4222-8222-222222222222';
const statRecord = (start) => `137 (worker (with spaces)) S ${Array(18).fill('0').join(' ')} ${start} 0`;

describe('cleanup process instance identity', () => {
  it('distinguishes Linux PID reuse and a reboot with the same PID and start ticks', async () => {
    let start = '700';
    let boot = firstBoot;
    const dependencies = {
      platform: 'linux', env: {}, exists: () => true,
      readFileImpl: vi.fn(async (file) => file.endsWith('/stat') ? statRecord(start) : boot),
    };
    expect(await readProcessInstance(137, dependencies)).toBe(`linux:${firstBoot}:700`);
    start = '900';
    expect(await readProcessInstance(137, dependencies)).toBe(`linux:${firstBoot}:900`);
    boot = secondBoot;
    expect(await readProcessInstance(137, dependencies)).toBe(`linux:${secondBoot}:900`);
  });

  it('uses macOS boot UUID and UTC process creation time', async () => {
    let start = 'Fri Oct 30 20:00:00 2026';
    const execFileImpl = vi.fn(async (binary) => ({ stdout: binary === '/bin/ps' ? start : firstBoot.toUpperCase() }));
    const dependencies = { platform: 'darwin', env: {}, exists: () => true, execFileImpl };
    expect(await readProcessInstance(137, dependencies)).toBe(`darwin:${firstBoot}:${start}`);
    start = 'Fri Oct 30 21:00:00 2026';
    expect(await readProcessInstance(137, dependencies)).toBe(`darwin:${firstBoot}:${start}`);
    expect(execFileImpl).toHaveBeenCalledWith('/bin/ps', ['-p', '137', '-o', 'lstart='], expect.objectContaining({
      timeout: 2_000, windowsHide: true, env: { LC_ALL: 'C', TZ: 'UTC' },
    }));
  });

  it('uses full Windows creation ticks and a first-level hidden PowerShell process', async () => {
    const ticks = '639290016000000001';
    const execFileImpl = vi.fn(async () => ({ stdout: `${ticks}\r\n` }));
    expect(await readProcessInstance(137, {
      platform: 'win32', env: { SystemRoot: 'D:\\OS' }, exists: () => true, execFileImpl,
    })).toBe(`win32:${ticks}`);
    const [binary, args, options] = execFileImpl.mock.calls[0];
    expect(binary).toBe('D:\\OS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    const script = Buffer.from(args[5], 'base64').toString('utf16le');
    expect(script).toContain('GetProcessById(137)');
    expect(script).toContain('StartTime.ToUniversalTime().Ticks');
    expect(options).toMatchObject({ windowsHide: true, timeout: 2_000 });
  });

  it('returns null for an absent owner without launching a tool', async () => {
    const execFileImpl = vi.fn();
    expect(await readProcessInstance(137, { exists: () => false, execFileImpl })).toBeNull();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('handles a process exiting during the native read', async () => {
    const exists = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await readProcessInstance(137, {
      platform: 'darwin', env: {}, exists,
      execFileImpl: async () => { throw new Error('Process disappeared'); },
    })).toBeNull();
  });

  it('keeps permission and native read failures distinct from a dead owner', async () => {
    await expect(readProcessInstance(137, {
      platform: 'darwin', env: {}, exists: () => true,
      execFileImpl: async () => { throw new Error('Permission denied'); },
    })).rejects.toThrow('Permission denied');
    await expect(readProcessInstance(137, {
      platform: 'linux', env: {}, exists: () => true,
      readFileImpl: async () => 'invalid process stat',
    })).rejects.toThrow('Invalid Linux process start time');
  });

  it('rejects invalid PIDs and never interprets an unowned record as a process group', async () => {
    expect(() => readProcessInstance(-1)).toThrow('Invalid process id');
    expect(await readProcessInstance(0)).toBeNull();
  });

  it('reads a stable instance for the actual current process', async () => {
    const instance = await readProcessInstance(process.pid);
    expect(instance).toMatch(new RegExp(`^${process.platform}:`));
    expect(await readProcessInstance(process.pid)).toBe(instance);
  });
});
