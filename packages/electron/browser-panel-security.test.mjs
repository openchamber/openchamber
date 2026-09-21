import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAllowBrowserPanelCertificateError } from './browser-panel-security.mjs';

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
