import { afterEach, describe, expect, it } from 'vitest';

import { generateCompletionScript, parseArgs, showHelp, findClosestMatch } from './cli-args.js';
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

  it('rejects malformed --lines and --limit values instead of reinterpreting them', () => {
    for (const bad of ['10junk', '1e3', '10.9', 'abc', '-5', '0']) {
      expect(() => parseArgs(['logs', '--lines', bad])).toThrow(/Invalid lines value/);
      expect(() => parseArgs(['status', '--limit', bad])).toThrow(/Invalid limit value/);
    }
    expect(parseArgs(['logs', '--lines', '50']).options.lines).toBe(50);
    expect(parseArgs(['logs', '--lines', '007']).options.lines).toBe(7);
    expect(parseArgs(['status', '--limit', '25']).options.limit).toBe(25);
  });

  it('rejects malformed --timeout values instead of reinterpreting them', () => {
    for (const bad of ['10junk', '1e3', '10.9', 'abc', '-5', '0', '86401']) {
      expect(() => parseArgs(['session', 'send', '--wait', '--timeout', bad])).toThrow(/Invalid timeout value/);
    }
    expect(parseArgs(['session', 'send', '--wait', '--timeout', '1']).options.timeout).toBe('1');
    expect(parseArgs(['session', 'send', '--wait', '--timeout', '60']).options.timeout).toBe('60');
    expect(parseArgs(['session', 'send', '--wait', '--timeout', '86400']).options.timeout).toBe('86400');
  });

  it('ignores a password OpenChamber put into the shell', () => {
    delete process.env[INJECTED_ENV_KEY];
    delete process.env.OPENCHAMBER_UI_PASSWORD;
    assignInjectedEnv(process.env, { OPENCHAMBER_UI_PASSWORD: 'the-desktop-apps' });

    expect(parseArgs(['serve']).options.uiPassword).toBeUndefined();
    expect(parseArgs(['serve', '--ui-password', 'chosen']).options.uiPassword).toBe('chosen');
  });
});


describe('rotate-credentials command', () => {
  it('parses as its own command with the shared lifecycle options', () => {
    const parsed = parseArgs(['rotate-credentials', '--port', '3002']);
    expect(parsed.command).toBe('rotate-credentials');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.explicitPort).toBe(true);
  });

  it('is listed in the help text and every completion script', () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      showHelp();
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('rotate-credentials');
    expect(generateCompletionScript('bash')).toContain('rotate-credentials');
    expect(generateCompletionScript('zsh')).toContain('rotate-credentials');
    expect(generateCompletionScript('fish')).toContain('rotate-credentials');
  });
});

describe('handoff target options', () => {
  it('accepts an explicit successor entry and downgrade opt-in only for handoff', () => {
    const parsed = parseArgs(['handoff', '--entry', '/opt/new/bin/cli.js', '--allow-downgrade']);
    expect(parsed.options.handoffEntry).toBe('/opt/new/bin/cli.js');
    expect(parsed.options.allowDowngrade).toBe(true);
    expect(parseArgs(['status', '--entry', '/opt/new/bin/cli.js']).removedFlagErrors).toContain(
      'Unknown option for status: --entry (used by: handoff)',
    );
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
