import { describe, expect, it } from 'vitest';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';

describe('TunnelCliError', () => {
  it('preserves its error identity and own-property order', () => {
    const error = new TunnelCliError('failed');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed');
    expect(error.name).toBe('TunnelCliError');
    expect(error.exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
    expect(Object.keys(error)).toEqual(['name', 'exitCode']);
  });

  it('keeps an explicit exit code', () => {
    expect(new TunnelCliError('usage', EXIT_CODE.USAGE_ERROR).exitCode).toBe(EXIT_CODE.USAGE_ERROR);
  });
});
