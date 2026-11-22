import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote } from './cli-shell.js';

describe('replay argument quoting', () => {
  const values = ["someone's checkout", "Review someone's code", '', '$HOME; echo unsafe', 'a"b', 'a\nb'];

  it.each(values)('round-trips a POSIX argument: %j', (value) => {
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value, 'darwin')}`], { encoding: 'utf8' })).toBe(value);
  });

  it.each(values)('encodes a PowerShell literal argument: %j', (value) => {
    const quoted = shellQuote(value, 'win32');
    expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1).replaceAll("''", "'")).toBe(value);
    expect(quoted.slice(1, -1).replaceAll("''", '')).not.toContain("'");
  });
});
