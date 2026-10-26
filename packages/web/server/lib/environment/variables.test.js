import { describe, expect, it } from 'vitest';

import { isVariableName, overlayEnvironment, parseEnvironmentOutput } from './variables.js';

describe('parseEnvironmentOutput', () => {
  it('reads only exported variables from devenv/nix JSON and drops the build sandbox identity', () => {
    const output = JSON.stringify({
      variables: {
        PATH: { type: 'exported', value: '/nix/store/go/bin' },
        GOROOT: { type: 'exported', value: '/nix/store/go' },
        IFS: { type: 'var', value: ' ' },
        hooks: { type: 'array', value: ['a'] },
        HOME: { type: 'exported', value: '/homeless-shelter' },
        NIX_BUILD_TOP: { type: 'exported', value: '/build' },
        TMPDIR: { type: 'exported', value: '/build' },
        TMP: { type: 'exported', value: '/elsewhere' },
      },
    });
    expect(parseEnvironmentOutput(output)).toEqual({
      PATH: '/nix/store/go/bin',
      GOROOT: '/nix/store/go',
      TMP: '/elsewhere',
    });
  });

  it('reads flat JSON from direnv and skips variables it unsets', () => {
    expect(parseEnvironmentOutput('{"DATABASE_URL":"postgres://x","OLD":null}')).toEqual({ DATABASE_URL: 'postgres://x' });
  });

  it('reads export lines, quotes and references to earlier lines and the base environment', () => {
    const output = [
      '# comment',
      'export TOOLS="/opt/tools"',
      "NAME='plain value'",
      'PATH=$TOOLS/bin:${PATH}',
      'PRICE=\\$5',
      'WIN=C:\\Tools',
      'UNKNOWN=$NOPE',
      '1BAD=x',
    ].join('\n');
    expect(parseEnvironmentOutput(output, { PATH: '/usr/bin' })).toEqual({
      TOOLS: '/opt/tools',
      NAME: 'plain value',
      PATH: '/opt/tools/bin:/usr/bin',
      PRICE: '$5',
      WIN: 'C:\\Tools',
      UNKNOWN: '$NOPE',
    });
  });

  it('reads NUL-separated env -0 output', () => {
    expect(parseEnvironmentOutput('A=1\0B=two words\0')).toEqual({ A: '1', B: 'two words' });
  });

  it('answers null when the output holds no variable', () => {
    expect(parseEnvironmentOutput('')).toBeNull();
    expect(parseEnvironmentOutput('direnv: error .envrc is blocked')).toBeNull();
    expect(parseEnvironmentOutput('{"variables":{"IFS":{"type":"var","value":" "}}}')).toBeNull();
    expect(parseEnvironmentOutput('[1,2]')).toBeNull();
  });
});

describe('overlayEnvironment', () => {
  it('puts PATH-like entries in front of the inherited list without duplicates', () => {
    const base = { PATH: '/usr/bin:/bin', HOME: '/home/u' };
    expect(overlayEnvironment(base, { PATH: '/tools/bin:/usr/bin', GOPATH: '/go', HOME: '/other' }, ':')).toEqual({
      PATH: '/tools/bin:/usr/bin:/bin',
      GOPATH: '/go',
      HOME: '/other',
    });
    expect(base.PATH).toBe('/usr/bin:/bin');
  });

  it('keeps the inherited spelling of PATH', () => {
    expect(overlayEnvironment({ Path: 'C:\\Windows' }, { PATH: 'C:\\Tools' }, ';')).toEqual({ Path: 'C:\\Tools;C:\\Windows' });
  });
});

describe('isVariableName', () => {
  it('accepts environment identifiers and refuses the rest', () => {
    expect(isVariableName('API_KEY')).toBe(true);
    expect(isVariableName('_x1')).toBe(true);
    expect(isVariableName('1X')).toBe(false);
    expect(isVariableName('A-B')).toBe(false);
    expect(isVariableName('__proto__')).toBe(false);
  });
});
