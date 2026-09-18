import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserPanelPermissionAuditDetails,
  shouldAllowBrowserPanelCertificateError,
  shouldAllowBrowserPanelPermission,
} from './browser-panel-security.mjs';

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
