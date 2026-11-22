import { describe, expect, it } from 'vitest';

import { TrackerRouteError, routeError } from './route-error.js';

describe('tracker route errors', () => {
  it.each([undefined, null, '', 'refused', 42, false, { toString: () => 'provider message' }])('keeps native Error message coercion for %j', (message) => {
    const code = { providerCode: 'refused' };
    const error = routeError(502, code, message);
    expect(error).toBeInstanceOf(TrackerRouteError);
    expect(error.name).toBe('TrackerRouteError');
    expect(error.status).toBe(502);
    expect(error.code).toBe(code);
    expect(Object.getOwnPropertyDescriptor(error, 'message')).toEqual(
      Object.getOwnPropertyDescriptor(new Error(message), 'message'),
    );
  });

  it('retains native failures when a message cannot be coerced', () => {
    expect(() => routeError(502, 'REFUSED', Symbol('message'))).toThrow(TypeError);
    const failure = new Error('coercion failed');
    const message = { toString: () => { throw failure; } };
    expect(() => routeError(502, 'REFUSED', message)).toThrow(failure);
  });
});
