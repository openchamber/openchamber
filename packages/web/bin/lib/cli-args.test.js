import { afterEach, describe, expect, it } from 'vitest';

import { generateCompletionScript, parseArgs, showHelp } from './cli-args.js';
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
