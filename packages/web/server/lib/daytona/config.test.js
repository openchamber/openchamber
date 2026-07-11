import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDaytonaConfig } from './config.js';

describe('resolveDaytonaConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_SANDBOX_IMAGE;
    delete process.env.DAYTONA_SANDBOX_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns enabled: false when DAYTONA_API_KEY is missing', () => {
    const config = resolveDaytonaConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
  });

  it('returns enabled: false when DAYTONA_API_KEY is empty string', () => {
    process.env.DAYTONA_API_KEY = '   ';
    const config = resolveDaytonaConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
  });

  it('returns enabled: true with defaults when DAYTONA_API_KEY is set', () => {
    process.env.DAYTONA_API_KEY = 'test-api-key-123';
    const config = resolveDaytonaConfig();

    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe('test-api-key-123');
    expect(config.apiUrl).toBe('https://app.daytona.io');
    expect(config.sandboxImage).toBe('daytonaio/ai-opencode:latest');
    expect(config.timeoutMs).toBe(600000);
  });

  it('uses custom DAYTONA_API_URL when provided', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    process.env.DAYTONA_API_URL = 'https://custom.daytona.dev';
    const config = resolveDaytonaConfig();

    expect(config.apiUrl).toBe('https://custom.daytona.dev');
  });

  it('uses custom DAYTONA_SANDBOX_TIMEOUT_MS when valid number', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    process.env.DAYTONA_SANDBOX_TIMEOUT_MS = '300000';
    const config = resolveDaytonaConfig();

    expect(config.timeoutMs).toBe(300000);
  });

  it('falls back to default timeout when DAYTONA_SANDBOX_TIMEOUT_MS is non-numeric', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    process.env.DAYTONA_SANDBOX_TIMEOUT_MS = 'not-a-number';
    const config = resolveDaytonaConfig();

    expect(config.timeoutMs).toBe(600000);
  });

  it('falls back to default timeout when DAYTONA_SANDBOX_TIMEOUT_MS is negative', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    process.env.DAYTONA_SANDBOX_TIMEOUT_MS = '-500';
    const config = resolveDaytonaConfig();

    expect(config.timeoutMs).toBe(600000);
  });

  it('uses custom DAYTONA_SANDBOX_IMAGE when provided', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    process.env.DAYTONA_SANDBOX_IMAGE = 'my-org/custom-image:v2';
    const config = resolveDaytonaConfig();

    expect(config.sandboxImage).toBe('my-org/custom-image:v2');
  });

  it('trims whitespace from env var values', () => {
    process.env.DAYTONA_API_KEY = '  my-key  ';
    process.env.DAYTONA_API_URL = '  https://trimmed.url  ';
    const config = resolveDaytonaConfig();

    expect(config.apiKey).toBe('my-key');
    expect(config.apiUrl).toBe('https://trimmed.url');
  });
});
