import { describe, expect, it } from 'vitest';
import {
  AntigravityError,
  buildRunArgs,
  classifyFailure,
  formatTimeout,
  isValidArgumentToken,
  outcomeFromEnvelope,
  parseEnvelope,
  parseModelsOutput,
  parseTimeoutMs,
  redactSecrets,
  resolveBinary,
} from './cli.js';

describe('Antigravity CLI contract', () => {
  it('keeps only tab-separated model rows from the CLI output', () => {
    const output = [
      'Fetching available models...',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'gemini-3.8-flash-low\tduplicate row',
      '',
      'warning: something happened',
    ].join('\n');
    expect(parseModelsOutput(output)).toEqual([
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('asks for a machine-readable envelope and never expands slash commands', () => {
    const args = buildRunArgs({ model: 'gemini-3.8-flash-low', prompt: '/literal task', timeoutMs: 60_000, conversationId: 'conv-1' });
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--conversation');
    expect(args[args.indexOf('--print') + 1]).toBe('/literal task');
  });

  it('pairs auto-approval with the terminal sandbox', () => {
    const args = buildRunArgs({ prompt: 'task', timeoutMs: 60_000, skipPermissions: true });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--sandbox');
  });

  it('defaults and clamps timeouts', () => {
    expect(parseTimeoutMs(undefined)).toBe(15 * 60_000);
    expect(parseTimeoutMs('5m')).toBe(5 * 60_000);
    expect(parseTimeoutMs('2h')).toBe(60 * 60_000);
    expect(parseTimeoutMs('0s')).toBe(15 * 60_000);
    expect(formatTimeout(90_500)).toBe('91s');
  });

  it('finds the binary on PATH without depending on the caller shell', () => {
    const existing = new Set(['/usr/local/bin/agy']);
    expect(resolveBinary({ platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, isFile: (p) => existing.has(p) })).toBe('/usr/local/bin/agy');
    expect(resolveBinary({ platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => false })).toBeNull();
  });

  it('classifies the failures a user can fix', () => {
    expect(classifyFailure({ message: 'please sign in to continue' })).toBe('AUTH_REQUIRED');
    expect(classifyFailure({ message: 'quota exhausted for this account' })).toBe('QUOTA_EXHAUSTED');
    expect(classifyFailure({ message: 'model is not recognized as a known model' })).toBe('MODEL_NOT_FOUND');
    expect(classifyFailure({ message: 'anything else' })).toBe('AGY_FAILED');
  });

  it('accepts only the token shapes that reach argv', () => {
    expect(isValidArgumentToken('gemini-3.8-flash-low')).toBe(true);
    expect(isValidArgumentToken('192b1096-be25-422d-bea9-daf9720d7d94')).toBe(true);
    expect(isValidArgumentToken('--dangerously-skip-permissions')).toBe(false);
    expect(isValidArgumentToken('ses with space')).toBe(false);
    expect(isValidArgumentToken('a/b')).toBe(false);
    expect(isValidArgumentToken('')).toBe(false);
    expect(isValidArgumentToken(undefined)).toBe(false);
  });

  it('removes credentials from text shown to the model', () => {
    const text = [
      'proxy http://user:secret@corp.example:8080 failed',
      'Authorization: Bearer abc.def.ghi',
      'api_key=sk-live-1234567890',
      'GOOGLE AIzaSyA1234567890',
      'password=hunter2 token: xyz',
    ].join('\n');
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('secret@');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('sk-live-1234567890');
    expect(redacted).not.toContain('AIzaSyA1234567890');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('xyz');
    expect(redacted).toContain('corp.example:8080');
  });
});

describe('Antigravity result envelope', () => {
  it('reads the last JSON object when progress lines precede it', () => {
    expect(parseEnvelope('thinking\n{"status":"SUCCESS","response":"done"}')).toEqual({ status: 'SUCCESS', response: 'done' });
    expect(parseEnvelope('not json')).toBeNull();
  });

  it('treats a print timeout as an incomplete turn, whatever the status says', () => {
    expect(() => outcomeFromEnvelope({
      envelope: { status: 'SUCCESS', response: '', finished_reason: 'print_timeout' },
      stderr: '',
      exitCode: 0,
      durationMs: 10,
      model: 'm',
    })).toThrow(AntigravityError);
  });

  it('surfaces the headless soft-denial notice instead of an empty success', () => {
    let thrown;
    try {
      outcomeFromEnvelope({
        envelope: { status: 'SUCCESS', response: '' },
        stderr: 'a tool required the "run_command" permission that headless mode cannot prompt for',
        exitCode: 0,
        durationMs: 10,
        model: 'm',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AntigravityError);
    expect(thrown.code).toBe('PERMISSION_DENIED');
    expect(thrown.message).toContain('headless mode');
  });

  it('maps a successful envelope to the result the tool renders', () => {
    const result = outcomeFromEnvelope({
      envelope: {
        status: 'SUCCESS',
        response: 'Created the file.\n',
        conversation_id: 'conv-1',
        duration_seconds: 12.5,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      model: 'gemini-3.8-flash-low',
    });
    expect(result.response).toBe('Created the file.');
    expect(result.conversationId).toBe('conv-1');
    expect(result.durationMs).toBe(12_500);
  });
});
