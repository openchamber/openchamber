import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstanceApiBaseUrlAfterLogin } from '../src/lib/auth/resolveInstanceAfterLogin';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('resolveInstanceApiBaseUrlAfterLogin', () => {
  it('uses http by default for localhost inputs without scheme', () => {
    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'localhost:5173' });
    assert.equal(resolved.apiBaseUrl, 'http://localhost:5173/api');
    assert.equal(resolved.origin, 'http://localhost:5173');
  });

  it('uses https by default for non-local inputs without scheme', () => {
    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'example.com' });
    assert.equal(resolved.apiBaseUrl, 'https://example.com/api');
    assert.equal(resolved.origin, 'https://example.com');
  });

  it('preserves explicit scheme and /api suffix', () => {
    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'https://example.com/api' });
    assert.equal(resolved.apiBaseUrl, 'https://example.com/api');
    assert.equal(resolved.origin, 'https://example.com');
  });

  it('normalizes loopback host to current runtime origin to avoid CORS mismatch', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: {
          origin: 'http://127.0.0.1:5173',
        },
      },
    });

    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'localhost:5173' });
    assert.equal(resolved.apiBaseUrl, 'http://127.0.0.1:5173/api');
    assert.equal(resolved.origin, 'http://127.0.0.1:5173');
  });

  it('normalizes local host input to current runtime LAN origin when port matches', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: {
          origin: 'http://192.168.1.20:5173',
        },
      },
    });

    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'localhost:5173' });
    assert.equal(resolved.apiBaseUrl, 'http://192.168.1.20:5173/api');
    assert.equal(resolved.origin, 'http://192.168.1.20:5173');
  });

  it('preserves explicit private LAN host input', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: {
          origin: 'http://localhost:4040',
        },
      },
    });

    const resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: 'http://192.168.1.23:4040' });
    assert.equal(resolved.apiBaseUrl, 'http://192.168.1.23:4040/api');
    assert.equal(resolved.origin, 'http://192.168.1.23:4040');
  });
});
