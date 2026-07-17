import { describe, it, expect } from 'vitest';
import {
  parseVerbosityLevel,
  normalizeVerbosity,
  VERBOSITY_LEVELS,
  DEFAULT_VERBOSITY,
} from './messenger-verbosity.js';

describe('messenger-verbosity', () => {
  it('exposes the three canonical levels', () => {
    expect(VERBOSITY_LEVELS).toEqual(['quiet', 'normal', 'verbose']);
    expect(DEFAULT_VERBOSITY).toBe('normal');
  });

  it('parses canonical names case-insensitively', () => {
    expect(parseVerbosityLevel('quiet')).toBe('quiet');
    expect(parseVerbosityLevel('NORMAL')).toBe('normal');
    expect(parseVerbosityLevel('  Verbose ')).toBe('verbose');
  });

  it('maps aliases to canonical levels', () => {
    expect(parseVerbosityLevel('low')).toBe('quiet');
    expect(parseVerbosityLevel('min')).toBe('quiet');
    expect(parseVerbosityLevel('medium')).toBe('normal');
    expect(parseVerbosityLevel('default')).toBe('normal');
    expect(parseVerbosityLevel('high')).toBe('verbose');
    expect(parseVerbosityLevel('max')).toBe('verbose');
    expect(parseVerbosityLevel('full')).toBe('verbose');
  });

  it('returns null for unknown / empty input', () => {
    expect(parseVerbosityLevel('loud')).toBeNull();
    expect(parseVerbosityLevel('')).toBeNull();
    expect(parseVerbosityLevel('   ')).toBeNull();
    expect(parseVerbosityLevel(undefined)).toBeNull();
    expect(parseVerbosityLevel(42)).toBeNull();
  });

  it('normalizes any value to a valid level', () => {
    expect(normalizeVerbosity('verbose')).toBe('verbose');
    expect(normalizeVerbosity('bogus')).toBe('normal');
    expect(normalizeVerbosity(undefined)).toBe('normal');
  });
});
