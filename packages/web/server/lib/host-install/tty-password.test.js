import { describe, expect, it } from 'vitest';
import { cli } from './main.js';
import { typed } from './tty-password.js';
import { Readable } from 'node:stream';

const start = { value: '', done: false, cancelled: false };

describe('a password typed at the terminal', () => {
  it('ends at Enter or Ctrl-D, takes back a character on Backspace, and drops Ctrl-C\'s input', () => {
    expect(typed(start, 'secret\r')).toEqual({ value: 'secret', done: true, cancelled: false });
    expect(typed(typed(start, 'secrex'), '\u007ft\n')).toEqual({ value: 'secret', done: true, cancelled: false });
    expect(typed(start, 'abc\u0004')).toEqual({ value: 'abc', done: true, cancelled: false });
    expect(typed(start, 'secret\u0003')).toEqual({ value: '', done: true, cancelled: true });
  });

  it('types nothing for an arrow key or another control character', () => {
    const partial = typed(start, 'ab');
    expect(typed(partial, '\u001b[A')).toEqual(partial);
    expect(typed(partial, '\tc')).toEqual({ value: 'abc', done: false, cancelled: false });
  });
});

describe('the UI password the install command reads', () => {
  const run = async (argv, { input = Readable.from([]), askPassword = async () => 'from the terminal' } = {}) => {
    let readUiPassword;
    const out = { write: () => {} };
    await cli(['install', '--owner', 'alice', ...argv], { out, err: out, input, askPassword, commands: { install: async (options) => { readUiPassword = options.readUiPassword; return {}; } } });
    return readUiPassword();
  };

  it('comes from stdin with --ui-password-stdin, else from the terminal, and never in JSON or quiet mode', async () => {
    expect(await run(['--ui-password-stdin'], { input: Readable.from(['piped ', 'secret']) })).toBe('piped secret');
    expect(await run([])).toBe('from the terminal');
    expect(await run(['--json'])).toBeNull();
    expect(await run(['--quiet'])).toBeNull();
  });
});
