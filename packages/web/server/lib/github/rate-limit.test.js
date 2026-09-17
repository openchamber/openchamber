import { afterEach, describe, expect, mock, test } from 'bun:test';

const realDateNow = Date.now;

const {
  hostFromError,
  isGitHubRateLimited,
  isGitHubRateLimitError,
  noteIfGitHubRateLimit,
} = await import('./rate-limit.js');

// A far-ahead base time so cooldowns recorded by an earlier test in this file
// (which share the module's per-host state) have already expired by the time
// this test starts.
const NOW_BASE = 1_800_000_000_000;

const rateLimit403 = () => {
  const error = new Error('rate limit exceeded');
  error.status = 403;
  error.response = {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  };
  return error;
};

const setNow = (ms) => {
  Date.now = mock(() => ms);
};

describe('rate-limit', () => {
  afterEach(() => {
    Date.now = realDateNow;
  });

  test('isGitHubRateLimitError only flags true rate-limit responses', () => {
    expect(isGitHubRateLimitError(rateLimit403())).toBe(true);

    const other403 = new Error('access denied');
    other403.status = 403;
    other403.response = { status: 403, headers: { 'x-ratelimit-remaining': '5000' } };
    expect(isGitHubRateLimitError(other403)).toBe(false);

    const empty = new Error('boom');
    empty.status = 500;
    expect(isGitHubRateLimitError(empty)).toBe(false);
  });

  test('cooldown is isolated per host', () => {
    setNow(NOW_BASE);

    const gheError = rateLimit403();
    gheError.request = { url: 'https://github.example.com/api/v3/repos/acme/app' };
    noteIfGitHubRateLimit(gheError);

    // Rate-limiting the enterprise instance leaves github.com clear.
    expect(isGitHubRateLimited('github.example.com')).toBe(true);
    expect(isGitHubRateLimited('github.com')).toBe(false);
  });

  test('api.github.com and github.com share the same cooldown key', () => {
    setNow(NOW_BASE);

    const ghError = rateLimit403();
    ghError.request = { url: 'https://api.github.com/repos/acme/app' };
    noteIfGitHubRateLimit(ghError);

    // Both the github.com label and its REST root are one cooldown key.
    expect(isGitHubRateLimited('github.com')).toBe(true);
    expect(isGitHubRateLimited('api.github.com')).toBe(true);

    // An unrelated enterprise host got no request here, so it is unaffected.
    expect(isGitHubRateLimited('enterprise.do-not-collide.test')).toBe(false);
  });

  test('cooldown expires after the retry window', () => {
    setNow(NOW_BASE);

    const error = rateLimit403();
    error.response.headers['retry-after'] = '2';
    error.request = { url: 'https://expiry.do-not-collide.test/repos/acme/app' };
    noteIfGitHubRateLimit(error);

    expect(isGitHubRateLimited('expiry.do-not-collide.test')).toBe(true);

    // Just past the 2s retry window the cooldown has lifted.
    setNow(NOW_BASE + 3_000);
    expect(isGitHubRateLimited('expiry.do-not-collide.test')).toBe(false);
  });

  test('hostFromError maps api.github.com to github.com but keeps other hosts', () => {
    expect(hostFromError({ request: { url: 'https://api.github.com/repos/acme/app' } })).toBe('github.com');
    expect(hostFromError({ request: { url: 'https://github.com/repos/acme/app' } })).toBe('github.com');
    expect(hostFromError({ request: { url: 'https://github.example.com/api/v3/repos/acme/app' } })).toBe('github.example.com');
    // Unparseable or absent URLs must not clear git requests for the wrong host.
    expect(hostFromError(new Error('boom'))).toBe('github.com');
    expect(hostFromError(undefined)).toBe('github.com');
  });
});
