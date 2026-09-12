import { describe, expect, it } from 'vitest';

import { OpenChamberControlError, asControlError } from './error.js';

describe('asControlError', () => {
  it('passes an OpenChamberControlError through untouched', () => {
    const original = new OpenChamberControlError('kept', 409, { target: { directory: '/repo' } });
    expect(asControlError(original, 'fallback')).toBe(original);
  });

  it('preserves a broker-style status and the failure target', () => {
    // The browser-control broker reports status and target, not statusCode;
    // converting one must keep both so the failure still names its scope.
    const brokerStyle = Object.assign(new Error('No connected window can serve /repo'), {
      status: 503,
      target: { directory: '/repo', tabId: 'tab-1' },
    });

    const converted = asControlError(brokerStyle, 'fallback');

    expect(converted).toBeInstanceOf(OpenChamberControlError);
    expect(converted.message).toBe('No connected window can serve /repo');
    expect(converted.statusCode).toBe(503);
    expect(converted.target).toEqual({ directory: '/repo', tabId: 'tab-1' });
  });

  it('still honors statusCode when status is absent, and prefers status when both exist', () => {
    const statusCodeOnly = Object.assign(new Error('older shape'), { statusCode: 422 });
    expect(asControlError(statusCodeOnly, 'fallback').statusCode).toBe(422);

    const both = Object.assign(new Error('both set'), { status: 503, statusCode: 418 });
    expect(asControlError(both, 'fallback').statusCode).toBe(503);
  });

  it('omits the target when the source error has none', () => {
    const converted = asControlError(new Error('plain'), 'fallback', 500);
    expect(converted.statusCode).toBe(500);
    expect('target' in converted).toBe(false);
  });

  it('keeps the goalConfigured passthrough and falls back for non-errors', () => {
    const flagged = Object.assign(new Error('goal'), { goalConfigured: true });
    expect(asControlError(flagged, 'fallback').goalConfigured).toBe(true);

    const fromString = asControlError('not an error', 'fallback message', 502);
    expect(fromString.message).toBe('fallback message');
    expect(fromString.statusCode).toBe(502);
  });
});
