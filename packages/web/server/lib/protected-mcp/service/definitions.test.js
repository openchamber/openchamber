import { describe, expect, it } from 'vitest';
import { destinationFingerprint, parseDefinition, secretSlots } from './definitions.js';

const codeOf = (run) => {
  try {
    run();
  } catch (error) {
    return error.code;
  }
  return null;
};

const stdio = {
  name: 'gitlab',
  transport: 'stdio',
  stdio: {
    command: '/opt/mcp-gitlab/bin/mcp-gitlab',
    args: ['--read-only'],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: { secret: 'token' }, GITLAB_API_URL: 'https://gitlab.com/api/v4' },
  },
  policy: { denyTools: ['delete_project'] },
};

const http = {
  name: 'sentry',
  transport: 'http',
  http: { url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: { secret: 'token', prefix: 'Bearer ' } } },
};

describe('connection definitions', () => {
  it.each(['http://callback.example/callback', 'https://app.example/api/protected-mcp/oauth/callback'])('accepts a fixed OAuth return address %s as part of the destination', (redirectUri) => {
    // Given
    const base = { name: 'oauth', transport: 'http', http: { url: 'https://mcp.example/mcp', oauth: { scopes: [] } } };
    // When
    const parsed = parseDefinition({ ...base, http: { ...base.http, oauth: { scopes: [], redirectUri } } });
    // Then
    expect(parsed.http.oauth.redirectUri).toBe(redirectUri);
    expect(destinationFingerprint(parsed)).not.toBe(destinationFingerprint(parseDefinition(base)));
  });

  it.each(['relative', 'ftp://app.example/callback', 'https://user:pass@app.example/callback', 'https://app.example/callback#fragment', `https://app.example/${'x'.repeat(2048)}`, 42])('refuses an invalid OAuth return address %s', (redirectUri) => {
    // Given / When / Then
    expect(() => parseDefinition({ name: 'oauth', transport: 'http', http: { url: 'https://mcp.example/mcp', oauth: { redirectUri } } }))
      .toThrow(expect.objectContaining({ code: 'invalid_redirect_uri', message: 'invalid_redirect_uri: http.oauth.redirectUri' }));
  });

  it('normalizes stdio and http definitions and lists their secret slots', () => {
    const parsed = parseDefinition(stdio);
    expect(parsed.stdio.env.GITLAB_PERSONAL_ACCESS_TOKEN).toEqual({ secret: 'token' });
    expect(secretSlots(parsed)).toEqual(['token']);
    expect(secretSlots(parseDefinition(http))).toEqual(['token']);
  });

  it('never lets a secret reach command arguments', () => {
    expect(codeOf(() => parseDefinition({ ...stdio, stdio: { ...stdio.stdio, args: [{ secret: 'token' }] } })))
      .toBe('secret_in_arguments');
  });

  it('accepts https anywhere and plain http only on loopback, without userinfo', () => {
    expect(parseDefinition({ ...http, http: { url: 'http://127.0.0.1:41904/mcp' } }).http.url).toBe('http://127.0.0.1:41904/mcp');
    expect(codeOf(() => parseDefinition({ ...http, http: { url: 'http://mcp.example.com/mcp' } }))).toBe('insecure_url');
    expect(codeOf(() => parseDefinition({ ...http, http: { url: 'https://user:pass@mcp.example.com/mcp' } }))).toBe('insecure_url');
  });

  it('requires an absolute command or an exact package version', () => {
    expect(codeOf(() => parseDefinition({ ...stdio, stdio: { ...stdio.stdio, command: 'npx' } }))).toBe('invalid_command');
    expect(codeOf(() => parseDefinition({ ...stdio, stdio: { ...stdio.stdio, command: { package: '@zereight/mcp-gitlab', version: '^2.0.0', bin: 'mcp-gitlab' } } })))
      .toBe('invalid_package');
    expect(parseDefinition({ ...stdio, stdio: { ...stdio.stdio, command: { package: '@zereight/mcp-gitlab', version: '2.0.12', bin: 'mcp-gitlab' } } }).stdio.command)
      .toEqual({ package: '@zereight/mcp-gitlab', version: '2.0.12', bin: 'mcp-gitlab' });
  });

  it('changes the fingerprint for every destination change and for nothing else', () => {
    const base = destinationFingerprint(parseDefinition(stdio));
    const changed = [
      { ...stdio, stdio: { ...stdio.stdio, command: '/opt/other/bin/mcp' } },
      { ...stdio, stdio: { ...stdio.stdio, args: [] } },
      { ...stdio, stdio: { ...stdio.stdio, env: { ...stdio.stdio.env, GITLAB_API_URL: 'https://attacker.invalid' } } },
    ];
    for (const definition of changed) expect(destinationFingerprint(parseDefinition(definition))).not.toBe(base);
    const unchanged = [
      { ...stdio, name: 'gitlab-work' },
      { ...stdio, policy: { denyTools: [] } },
      { ...stdio, enabled: false },
    ];
    for (const definition of unchanged) expect(destinationFingerprint(parseDefinition(definition))).toBe(base);
    const remote = destinationFingerprint(parseDefinition(http));
    expect(destinationFingerprint(parseDefinition({ ...http, http: { ...http.http, url: 'https://attacker.invalid/mcp' } }))).not.toBe(remote);
  });
});
