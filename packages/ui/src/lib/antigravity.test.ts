import { describe, expect, test } from 'bun:test';
import { parseAntigravityStatus } from './antigravity';

describe('Antigravity status parsing', () => {
  test('keeps the fields the page renders', () => {
    const parsed = parseAntigravityStatus({
      installed: true,
      binaryPath: '/usr/local/bin/agy',
      version: '1.4.12',
      models: [
        { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        { id: 'claude-sonnet-4-6' },
      ],
      error: null,
      blocked: false,
      managed: true,
      checkedAt: 42,
    });
    expect(parsed).toEqual({
      installed: true,
      binaryPath: '/usr/local/bin/agy',
      version: '1.4.12',
      models: [
        { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
      ],
      error: null,
      blocked: false,
      managed: true,
      checkedAt: 42,
    });
  });

  test('drops model rows without an id and treats an absent managed flag as managed', () => {
    const parsed = parseAntigravityStatus({
      installed: false,
      models: [{ name: 'no id' }, { id: '' }, { id: 'ok', name: 'OK' }],
      error: { code: 'AUTH_REQUIRED', message: 'sign in' },
    });
    expect(parsed?.models).toEqual([{ id: 'ok', name: 'OK' }]);
    expect(parsed?.managed).toBe(true);
    expect(parsed?.blocked).toBe(false);
    expect(parsed?.error).toEqual({ code: 'AUTH_REQUIRED', message: 'sign in' });
  });

  test('an unreadable payload is a failed read', () => {
    expect(parseAntigravityStatus(null)).toBeNull();
    expect(parseAntigravityStatus({ models: [] })).toBeNull();
  });
});
