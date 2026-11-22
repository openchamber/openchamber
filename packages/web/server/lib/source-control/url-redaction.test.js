import { describe, expect, it } from 'vitest';

import { redactSensitiveText } from './url-redaction.js';

// #1920 oracle: the probe secret must never survive, whatever shape the
// credential arrives in. Controls pin the shapes that were already clean.
const SECRET = 'SECRET123';

describe('redactSensitiveText (#1920)', () => {
  it.each([
    ['authorization Bearer header', 'authorization: Bearer SECRET123'],
    ['authorization Basic header', 'authorization: Basic SECRET123'],
    ['capitalized Authorization Bearer header', 'Authorization: Bearer SECRET123'],
    ['x-api-key colon form', 'x-api-key: SECRET123'],
    ['x-api-key equals form', 'x-api-key=SECRET123'],
    ['api_key assignment', 'api_key=SECRET123'],
    ['access_token assignment', 'access_token=SECRET123'],
    ['client_secret assignment', 'client_secret: SECRET123'],
    ['oauth_token assignment', 'oauth_token=SECRET123'],
    ['password assignment', 'password=SECRET123'],
    ['private_token assignment', 'private_token=SECRET123'],
    ['secret assignment', 'secret=SECRET123'],
    ['token assignment', 'token: SECRET123'],
    ['relay-shaped Bearer error', 'relay error: authorization: Bearer SECRET123'],
    ['relay-shaped api-key error', 'relay error: x-api-key: SECRET123'],
  ])('redacts the secret in: %s', (_name, input) => {
    const output = redactSensitiveText(input);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[redacted]');
  });

  it('keeps the scheme word while dropping the credential', () => {
    expect(redactSensitiveText('authorization: Bearer SECRET123')).toBe('authorization: Bearer [redacted]');
    expect(redactSensitiveText('authorization: Basic SECRET123')).toBe('authorization: Basic [redacted]');
  });

  it('still strips credentials inside URLs and drops their queries', () => {
    expect(redactSensitiveText('failed https://user:SECRET123@example.com/repo')).toBe('failed https://example.com/repo');
    expect(redactSensitiveText('failed https://example.com/repo?access_token=SECRET123')).toBe('failed https://example.com/repo');
  });

  it('still redacts a directly attached authorization value', () => {
    expect(redactSensitiveText('Authorization: SECRET123')).toBe('Authorization=[redacted]');
  });

  it('leaves credential-free text untouched', () => {
    expect(redactSensitiveText('relay error: connection reset by peer')).toBe('relay error: connection reset by peer');
    expect(redactSensitiveText('')).toBe('');
  });
});

// #2074 oracle: the residual shapes PR #1972 missed — scheme-headed
// assignment values and quoted JSON forms — must not leak the probe
// secret either, and must keep the scheme word / JSON structure.
describe('redactSensitiveText (#2074 residual shapes)', () => {
  it.each([
    ['authorization equals Bearer', 'authorization=Bearer SECRET123'],
    ['authorization equals Basic', 'authorization=Basic SECRET123'],
    ['token equals Bearer', 'token=Bearer SECRET123'],
    ['api_key colon Bearer', 'api_key: Bearer SECRET123'],
    ['JSON authorization Bearer', '{"authorization": "Bearer SECRET123"}'],
    ['JSON x-api-key', '{"x-api-key": "SECRET123"}'],
    ['quoted authorization value', 'authorization: "Bearer SECRET123"'],
  ])('redacts the secret in: %s', (_name, input) => {
    const output = redactSensitiveText(input);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[redacted]');
  });

  it('preserves the scheme word and JSON structure', () => {
    expect(redactSensitiveText('authorization=Bearer SECRET123')).toBe('authorization=Bearer [redacted]');
    expect(redactSensitiveText('api_key: Bearer SECRET123')).toBe('api_key: Bearer [redacted]');
    expect(redactSensitiveText('{"authorization": "Bearer SECRET123"}')).toBe('{"authorization": "Bearer [redacted]"}');
    expect(redactSensitiveText('{"x-api-key": "SECRET123"}')).toBe('{"x-api-key": "[redacted]"}');
  });

  it('leaves credential-free JSON byte-identical', () => {
    expect(redactSensitiveText('{"ref": "main", "state": "open"}')).toBe('{"ref": "main", "state": "open"}');
  });

  it('redacts single-quoted credential shapes while preserving their structure', () => {
    expect(redactSensitiveText("{'x-api-key': 'SECRET123'}")).toBe("{'x-api-key': '[redacted]'}");
    expect(redactSensitiveText("{'password': 'SECRET123'}")).toBe("{'password': '[redacted]'}");
    expect(redactSensitiveText("{'authorization': 'Bearer SECRET123'}")).toBe("{'authorization': 'Bearer [redacted]'}");
    expect(redactSensitiveText("authorization: 'Bearer SECRET123'")).toBe("authorization: 'Bearer [redacted]'");
    expect(redactSensitiveText("{'ref': 'main'}")).toBe("{'ref': 'main'}");
  });
});
