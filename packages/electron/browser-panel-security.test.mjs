import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserPanelPermissionAuditDetails,
  browserPanelWindowOpenTarget,
  plainChromeUserAgent,
  shouldAllowBrowserPanelCertificateError,
  shouldAllowBrowserPanelPermission,
} from './browser-panel-security.mjs';

test('opens a scripted popup as a window, so a sign-in can post back to its opener', () => {
  assert.equal(browserPanelWindowOpenTarget({
    url: 'https://accounts.google.com/o/oauth2/auth',
    disposition: 'new-window',
    hasPostBody: false,
  }), 'popup');
});

test('opens a link meant for a new tab in a panel tab, in front or behind as asked', () => {
  assert.equal(browserPanelWindowOpenTarget({ url: 'https://example.com', disposition: 'foreground-tab', hasPostBody: false }), 'tab');
  assert.equal(browserPanelWindowOpenTarget({ url: 'https://example.com', disposition: 'background-tab', hasPostBody: false }), 'background-tab');
});

test('keeps a POST form aimed at a new tab in place, since a tab could only repeat it as a GET', () => {
  assert.equal(browserPanelWindowOpenTarget({ url: 'https://example.com/submit', disposition: 'foreground-tab', hasPostBody: true }), 'in-place');
});

test('refuses windows for anything that is not a web address', () => {
  assert.equal(browserPanelWindowOpenTarget({ url: 'file:///etc/passwd', disposition: 'new-window', hasPostBody: false }), 'deny');
  assert.equal(browserPanelWindowOpenTarget({ url: 'javascript:alert(1)', disposition: 'foreground-tab', hasPostBody: false }), 'deny');
  assert.equal(browserPanelWindowOpenTarget({ url: 'not a url', disposition: 'new-window', hasPostBody: false }), 'deny');
});

test('loads any other http(s) request in the opening page', () => {
  assert.equal(browserPanelWindowOpenTarget({ url: 'https://example.com', disposition: 'other', hasPostBody: false }), 'in-place');
});

test('allows focused pages to copy through the system clipboard', () => {
  assert.equal(shouldAllowBrowserPanelPermission({
    permission: 'clipboard-sanitized-write',
    requestingUrl: 'https://example.com/account',
    isFocused: true,
  }), true);
});

test('denies clipboard writes when the browser page is not focused', () => {
  assert.equal(shouldAllowBrowserPanelPermission({
    permission: 'clipboard-sanitized-write',
    requestingUrl: 'https://example.com/account',
    isFocused: false,
  }), false);
});

test('allows a focused localhost page to read the system clipboard', () => {
  assert.equal(shouldAllowBrowserPanelPermission({
    permission: 'clipboard-read',
    requestingUrl: 'http://localhost:3000/',
    isFocused: true,
  }), true);
});

test('denies clipboard reads outside focused localhost pages', () => {
  for (const request of [
    { requestingUrl: 'https://example.com/', isFocused: true },
    { requestingUrl: 'http://localhost.example.com/', isFocused: true },
    // Remote dev servers use a 127.0.0.1 bridge, so it must not inherit local
    // clipboard-read trust merely because the transport terminates on loopback.
    { requestingUrl: 'http://127.0.0.1:3000/', isFocused: true },
    { requestingUrl: 'https://[::1]:3000/', isFocused: true },
    { requestingUrl: 'http://localhost:3000/', isFocused: false },
    { requestingUrl: 'not a url', isFocused: true },
  ]) {
    assert.equal(shouldAllowBrowserPanelPermission({
      permission: 'clipboard-read',
      ...request,
    }), false);
  }
});

test('keeps device permissions denied and redacts request data from audit logs', () => {
  const fixture = 'test_secret_not_real_123';
  const request = {
    permission: 'media',
    requestingUrl: `https://example.com/?token=${fixture}`,
    isFocused: true,
  };
  const decision = shouldAllowBrowserPanelPermission(request);
  const auditDetails = browserPanelPermissionAuditDetails(request);

  assert.equal(decision, false);
  assert.deepEqual(auditDetails, { permission: 'media' });
  assert.equal(JSON.stringify(auditDetails).includes(fixture), false);
});

test('allows untrusted certificate authorities for loopback HTTPS pages', () => {
  for (const url of [
    'https://localhost:58580/',
    'https://127.0.0.1:58580/',
    'https://[::1]:58580/',
  ]) {
    assert.equal(shouldAllowBrowserPanelCertificateError({
      url,
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
    }), true);
  }
});

test('keeps certificate validation for non-loopback pages', () => {
  for (const url of [
    'https://example.com/',
    'https://localhost.example.com/',
    'https://0.0.0.0:58580/',
  ]) {
    assert.equal(shouldAllowBrowserPanelCertificateError({
      url,
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
    }), false);
  }
});

test('does not bypass other certificate failures or malformed URLs', () => {
  assert.equal(shouldAllowBrowserPanelCertificateError({
    url: 'https://localhost:58580/',
    error: 'net::ERR_CERT_DATE_INVALID',
  }), false);
  assert.equal(shouldAllowBrowserPanelCertificateError({
    url: 'not a url',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
  }), false);
});

test('plainChromeUserAgent drops the app and Electron tokens', () => {
  const electronDefault = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenChamber/2.1.1 Chrome/140.0.7339.41 Electron/38.1.0 Safari/537.36';
  assert.equal(
    plainChromeUserAgent(electronDefault),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36',
  );
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(plainChromeUserAgent(chrome), chrome);
});
