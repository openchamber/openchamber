import { describe, expect, test } from 'bun:test';

import {
  parseProjectShellEnvVars,
  serializeProjectShellEnvVars,
} from './projectShellEnv';

describe('project shell env vars text bridge', () => {
  test('parses NAME=value lines, ignoring blanks and comments', () => {
    expect(parseProjectShellEnvVars('A=1\n\n# note\nB=two words\n')).toEqual({
      vars: { A: '1', B: 'two words' },
      invalid: [],
    });
  });

  test('reports lines without a valid name', () => {
    expect(parseProjectShellEnvVars('GOOD=1\nnot a var\n1BAD=x\n')).toEqual({
      vars: { GOOD: '1' },
      invalid: ['not a var', '1BAD'],
    });
  });

  test('keeps the first equals sign in the value', () => {
    expect(parseProjectShellEnvVars('URL=https://example.com/?a=b')).toEqual({
      vars: { URL: 'https://example.com/?a=b' },
      invalid: [],
    });
  });

  test('round-trips the stored object', () => {
    const vars = { A: '1', B: 'two words' };
    expect(parseProjectShellEnvVars(serializeProjectShellEnvVars(vars))).toEqual({ vars, invalid: [] });
    expect(serializeProjectShellEnvVars(null)).toBe('');
    expect(serializeProjectShellEnvVars(undefined)).toBe('');
  });
});
