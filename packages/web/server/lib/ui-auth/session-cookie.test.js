import { describe, expect, test } from 'bun:test';
import {
  SESSION_COOKIE_BASE,
  sessionCookieNameForRequest,
} from './session-cookie.js';

const req = (host, forwarded) => ({
  headers: {
    ...(host ? { host } : {}),
    ...(forwarded ? { 'x-forwarded-host': forwarded } : {}),
  },
});

describe('sessionCookieNameForRequest', () => {
  test('keeps the bare base name when the host has no explicit port', () => {
    expect(sessionCookieNameForRequest(req('192.168.0.1'))).toBe(SESSION_COOKIE_BASE);
    expect(sessionCookieNameForRequest(req('example.com'))).toBe(SESSION_COOKIE_BASE);
    expect(sessionCookieNameForRequest(req(''))).toBe(SESSION_COOKIE_BASE);
    expect(sessionCookieNameForRequest(undefined)).toBe(SESSION_COOKIE_BASE);
  });

  test('folds the port into the name so LAN instances on one IP are isolated', () => {
    expect(sessionCookieNameForRequest(req('192.168.0.1:3000'))).toBe('oc_ui_session_3000');
    expect(sessionCookieNameForRequest(req('192.168.0.1:3001'))).toBe('oc_ui_session_3001');
    expect(sessionCookieNameForRequest(req('192.168.0.1:8080'))).toBe('oc_ui_session_8080');
  });

  test('handles IPv6 authorities', () => {
    expect(sessionCookieNameForRequest(req('[::1]:3000'))).toBe('oc_ui_session_3000');
    expect(sessionCookieNameForRequest(req('[::1]'))).toBe(SESSION_COOKIE_BASE);
  });

  test('prefers the forwarded host port over the direct host', () => {
    expect(sessionCookieNameForRequest(req('127.0.0.1:3902', '203.0.113.9:8443')))
      .toBe('oc_ui_session_8443');
  });

  test('ignores malformed or non-numeric ports', () => {
    expect(sessionCookieNameForRequest(req('192.168.0.1:notaport'))).toBe(SESSION_COOKIE_BASE);
  });

  test('honours a custom base name', () => {
    expect(sessionCookieNameForRequest(req('127.0.0.1:3000'), 'my_app')).toBe('my_app_3000');
    expect(sessionCookieNameForRequest(req('127.0.0.1'), 'my_app')).toBe('my_app');
  });
});
