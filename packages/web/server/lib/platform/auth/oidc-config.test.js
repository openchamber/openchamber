import { describe, expect, it, vi } from 'vitest';

import { isDevIssuer, resolveOidcConfig } from './oidc-config.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

describe('resolveOidcConfig', () => {
  it('requires the issuer', () => {
    expect(() => resolveOidcConfig({ env: {}, logger: silentLogger }))
      .toThrow(/OPENCHAMBER_PLATFORM_OIDC_ISSUER/);
  });

  it('requires the client id', () => {
    expect(() => resolveOidcConfig({
      env: { OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'https://idp.example.com' },
      logger: silentLogger,
    })).toThrow(/OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID/);
  });

  it('rejects a non-URL issuer', () => {
    expect(() => resolveOidcConfig({
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'not a url',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
      },
      logger: silentLogger,
    })).toThrow(/valid URL/);
  });

  it('rejects non-http(s) issuers', () => {
    expect(() => resolveOidcConfig({
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'ftp://idp.example.com',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
      },
      logger: silentLogger,
    })).toThrow(/http or https/);
  });

  it('refuses a loopback/http issuer without the dev-auth kill switch (fail closed)', () => {
    const logger = { warn: vi.fn() };
    expect(() => resolveOidcConfig({
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'http://127.0.0.1:9999',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
      },
      logger,
    })).toThrow(/ALLOW_DEV_AUTH/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a loopback issuer with the kill switch and logs a loud warning', () => {
    const logger = { warn: vi.fn() };
    const config = resolveOidcConfig({
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'http://127.0.0.1:9999',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
        OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH: 'true',
      },
      logger,
    });
    expect(config.devAuth).toBe(true);
    expect(config.clientSecret).toBeNull();
    expect(config.redirectUri).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DEV AUTH IS ACTIVE'));
  });

  it('accepts an https issuer without the kill switch', () => {
    const logger = { warn: vi.fn() };
    const config = resolveOidcConfig({
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'https://idp.example.com',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_SECRET: 's3cret',
        OPENCHAMBER_PLATFORM_OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback',
      },
      logger,
    });
    expect(config.devAuth).toBe(false);
    expect(config.clientSecret).toBe('s3cret');
    expect(config.redirectUri).toBe('https://app.example.com/auth/callback');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('isDevIssuer only trusts https', () => {
    expect(isDevIssuer(new URL('https://idp.example.com'))).toBe(false);
    expect(isDevIssuer(new URL('http://idp.example.com'))).toBe(true);
    expect(isDevIssuer(new URL('http://127.0.0.1:1'))).toBe(true);
  });
});
