import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, isAutoAnsweringMode, isPermissionMode, toPermissionMode } from './modes.js';

describe('permission modes', () => {
  it('keeps the ordered mode vocabulary', () => {
    expect(PERMISSION_MODES).toEqual(['ask', 'safety', 'auto']);
  });

  it.each(['ask', 'safety', 'auto'])('recognizes and preserves %s', (mode) => {
    expect(isPermissionMode(mode)).toBe(true);
    expect(toPermissionMode(mode)).toBe(mode);
  });

  it.each([undefined, null, '', 'always', 0, 1, true, false, {}, [], ['auto']])('rejects the non-mode %j', (value) => {
    expect(isPermissionMode(value)).toBe(false);
    expect(isAutoAnsweringMode(value)).toBe(false);
    expect(toPermissionMode(value)).toBe(value === true ? 'auto' : value === false ? 'ask' : null);
  });

  it.each(['ask', 'safety', 'auto'])('uses %s only for legacy enabled entries', (legacyEnabledMode) => {
    expect(toPermissionMode(true, legacyEnabledMode)).toBe(legacyEnabledMode);
    expect(toPermissionMode(false, legacyEnabledMode)).toBe('ask');
    expect(toPermissionMode('auto', legacyEnabledMode)).toBe('auto');
  });

  it('auto-answers in safety and auto modes only', () => {
    expect(isAutoAnsweringMode('ask')).toBe(false);
    expect(isAutoAnsweringMode('safety')).toBe(true);
    expect(isAutoAnsweringMode('auto')).toBe(true);
  });
});
