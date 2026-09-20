import { describe, expect, it } from 'vitest';

import { runCommand } from './run-command.js';

const node = process.execPath;

describe('runCommand', () => {
  it('resolves the exit code and both outputs, also for a non-zero exit', async () => {
    const result = await runCommand(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;']);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('writes stdin to the child and closes it', async () => {
    const result = await runCommand(node, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'hello' });
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' });
  });

  it('closes stdin when there is no input, so a reader does not hang', async () => {
    const result = await runCommand(node, ['-e', 'process.stdin.on("data", () => {}).on("end", () => process.stdout.write("closed"))']);
    expect(result.stdout).toBe('closed');
  });

  it('passes arguments as they are, with no shell in between', async () => {
    const argument = '$(echo injected); echo "also" && `id`';
    const result = await runCommand(node, ['-e', 'process.stdout.write(process.argv[1])', argument]);
    expect(result.stdout).toBe(argument);
  });

  it('kills the child and rejects when it runs past the timeout', async () => {
    const started = Date.now();
    await expect(runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 })).rejects.toMatchObject({
      name: 'SpaceError',
      code: 'command_timeout',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills the child and rejects when it prints more than the cap', async () => {
    const flood = 'const chunk = "x".repeat(65536); setInterval(() => process.stdout.write(chunk), 1);';
    await expect(runCommand(node, ['-e', flood], { maxOutputBytes: 100_000, timeoutMs: 20_000 })).rejects.toMatchObject({
      code: 'command_output_too_large',
    });
  });

  it('rejects when the executable does not exist', async () => {
    await expect(runCommand('/nonexistent/openchamber-no-such-binary', ['version'])).rejects.toMatchObject({
      code: 'command_spawn_failed',
      details: { errno: 'ENOENT' },
    });
  });
});
