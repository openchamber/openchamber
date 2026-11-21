import { afterEach, describe, expect, it } from 'vitest';

import { findClosestMatch, generateCompletionScript, parseArgs } from './cli-args.js';
import { INJECTED_ENV_KEY, assignInjectedEnv } from '../../server/lib/injected-env.js';

describe('parseArgs ui password default', () => {
  const previous = {
    OPENCHAMBER_UI_PASSWORD: process.env.OPENCHAMBER_UI_PASSWORD,
    [INJECTED_ENV_KEY]: process.env[INJECTED_ENV_KEY],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('takes a password the user exported', () => {
    delete process.env[INJECTED_ENV_KEY];
    process.env.OPENCHAMBER_UI_PASSWORD = 'theirs';

    expect(parseArgs(['serve']).options.uiPassword).toBe('theirs');
  });

  it('ignores a password OpenChamber put into the shell', () => {
    delete process.env[INJECTED_ENV_KEY];
    delete process.env.OPENCHAMBER_UI_PASSWORD;
    assignInjectedEnv(process.env, { OPENCHAMBER_UI_PASSWORD: 'the-desktop-apps' });

    expect(parseArgs(['serve']).options.uiPassword).toBeUndefined();
    expect(parseArgs(['serve', '--ui-password', 'chosen']).options.uiPassword).toBe('chosen');
  });
});

describe('CLI argument helper boundaries', () => {
  it.each([null, undefined, false, 1, {}, []])('ignores non-text input %j', (value) => {
    expect(findClosestMatch(value, ['serve'])).toBeNull();
    expect(generateCompletionScript(value)).toBeNull();
  });

  it('preserves distance limits, case folding and the first equal match', () => {
    expect(findClosestMatch('SERV', ['stop', 'serve'])).toBe('serve');
    expect(findClosestMatch('hat', ['cat', 'bat'])).toBe('cat');
    expect(findClosestMatch('serv', ['serve'], 0)).toBeNull();
    expect(findClosestMatch('serv', ['serve'], 1)).toBe('serve');
    expect(findClosestMatch('serve', [])).toBeNull();
    expect(findClosestMatch('', ['serve'])).toBeNull();
  });

  it('keeps explicitly undefined defaults and absent conditional flags distinct', () => {
    const { options } = parseArgs([]);
    expect(Object.hasOwn(options, 'configPath')).toBe(true);
    expect(options.configPath).toBeUndefined();
    expect(Object.hasOwn(options, 'worktree')).toBe(false);
    expect(Object.hasOwn(options, 'setUpstream')).toBe(false);
    expect(Object.hasOwn(options, 'relay')).toBe(false);
    expect(parseArgs(['tunnel', 'start', '--config']).options.configPath).toBeNull();
    expect(parseArgs(['session', 'create', '--worktree']).options).toHaveProperty('worktree', undefined);
  });
});
