import { describe, it, expect } from 'vitest';
import { parseServeCliOptions } from './cli-options.js';

const portFor = (argv) => parseServeCliOptions({ argv, env: {}, defaultPort: 3000 }).port;

describe('parseServeCliOptions port handling', () => {
  it('accepts a valid port in separate-arg and inline forms', () => {
    expect(portFor(['--port', '8080'])).toBe(8080);
    expect(portFor(['--port=8080'])).toBe(8080);
  });

  it('falls back to the default port for out-of-range values', () => {
    expect(portFor(['--port', '99999'])).toBe(3000);
    expect(portFor(['--port', '-1'])).toBe(3000);
    expect(portFor(['--port', '0'])).toBe(3000);
  });

  it('falls back to the default port for malformed values instead of coercing them', () => {
    expect(portFor(['--port', '3000abc'])).toBe(3000);
    expect(portFor(['--port', '8080abc'])).toBe(3000);
    expect(portFor(['--port', '8080.9'])).toBe(3000);
    expect(portFor(['--port', '0x10'])).toBe(3000);
    expect(portFor(['--port', 'abc'])).toBe(3000);
  });

  it('uses the default port when no port is given', () => {
    expect(portFor([])).toBe(3000);
  });
});
