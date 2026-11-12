import assert from 'node:assert/strict';
import test from 'node:test';

import { keepSessionCookies, persistentCookieDetails } from './browser-panel-cookies.mjs';

const sessionCookie = {
  name: 'sid',
  value: 'v',
  domain: 'example.com',
  hostOnly: true,
  path: '/app',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: true,
};

test('rewrites a host-only session cookie without widening it to subdomains', () => {
  assert.deepEqual(persistentCookieDetails(sessionCookie, 1000), {
    url: 'https://example.com/app',
    name: 'sid',
    value: 'v',
    domain: undefined,
    path: '/app',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: 1000 + 400 * 24 * 60 * 60,
  });
});

test('keeps the domain of a cookie shared with subdomains', () => {
  const details = persistentCookieDetails({ ...sessionCookie, domain: '.example.com', hostOnly: false, secure: false }, 0);
  assert.equal(details.url, 'http://example.com/app');
  assert.equal(details.domain, '.example.com');
});

test('gives only session cookies an expiry, and one failure does not stop the rest', async () => {
  const written = [];
  const errors = [];
  const cookies = {
    get: async () => [
      sessionCookie,
      { ...sessionCookie, name: 'broken' },
      { ...sessionCookie, name: 'persistent', session: false },
    ],
    set: async (details) => {
      if (details.name === 'broken') throw new Error('rejected');
      written.push(details.name);
    },
  };
  await keepSessionCookies(cookies, { nowSeconds: 0, onError: (error) => errors.push(error.message) });
  assert.deepEqual(written, ['sid']);
  assert.deepEqual(errors, ['rejected']);
});
