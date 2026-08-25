import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-providers-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const {
  GIT_PROVIDER_DEFAULTS,
  GIT_PROVIDER_DEFAULT_DETECT_URLS,
  normalizeBaseUrl,
  normalizeDetectionHost,
  sanitizeGitProviders,
  readGitProvidersConfig,
  getProviderApiBaseUrl,
  getProviderDetectUrls,
  githubWebOriginFromApiBase,
  isSafeEndpointUrl,
} = await import('./config.js');

const SETTINGS_FILE = path.join(TEMP_DATA_DIR, 'settings.json');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.unlinkSync(SETTINGS_FILE);
  }
});

describe('normalizeBaseUrl', () => {
  test('adds https scheme when missing', () => {
    expect(normalizeBaseUrl('github.example.com')).toBe('https://github.example.com');
    expect(normalizeBaseUrl('gitlab.example.com/gitlab')).toBe('https://gitlab.example.com/gitlab');
  });

  test('strips trailing slashes but preserves subpaths', () => {
    expect(normalizeBaseUrl('https://github.example.com/api/v3/')).toBe('https://github.example.com/api/v3');
    expect(normalizeBaseUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
    expect(normalizeBaseUrl('https://gitlab.example.com/gitlab/')).toBe('https://gitlab.example.com/gitlab');
  });

  test('rejects non-https and private/loopback endpoints', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBeNull();
    expect(normalizeBaseUrl('http://github.example.com')).toBeNull();
    expect(normalizeBaseUrl('https://127.0.0.1/api')).toBeNull();
    expect(normalizeBaseUrl('https://10.0.0.1/api')).toBeNull();
    expect(normalizeBaseUrl('https://192.168.1.1/api')).toBeNull();
    expect(normalizeBaseUrl('https://[::1]/api')).toBeNull();
    expect(normalizeBaseUrl('file:///etc/passwd')).toBeNull();
  });

  test('returns null for empty or unparseable input', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl(42)).toBeNull();
  });
});

describe('normalizeDetectionHost', () => {
  test('extracts the host from https remotes', () => {
    expect(normalizeDetectionHost('https://Github.Example.com/owner/repo.git')).toBe('github.example.com');
    expect(normalizeDetectionHost('https://github.com/owner/repo')).toBe('github.com');
  });

  test('extracts the host from scp-like and ssh remotes', () => {
    expect(normalizeDetectionHost('git@github.example.com:owner/repo.git')).toBe('github.example.com');
    expect(normalizeDetectionHost('ssh://git@github.example.com/owner/repo.git')).toBe('github.example.com');
    expect(normalizeDetectionHost('github.example.com:owner/repo.git')).toBe('github.example.com');
  });

  test('handles ports, user info, and IPv6', () => {
    expect(normalizeDetectionHost('https://github.example.com:8443/owner/repo')).toBe('github.example.com');
    expect(normalizeDetectionHost('ssh://user@host.example.com/owner/repo')).toBe('host.example.com');
    expect(normalizeDetectionHost('[2001:db8::1]:owner/repo.git')).toBe('2001:db8::1');
    expect(normalizeDetectionHost('2001:db8::1')).toBe('2001:db8::1');
  });

  test('returns null for empty or unparseable input', () => {
    expect(normalizeDetectionHost('')).toBeNull();
    expect(normalizeDetectionHost(null)).toBeNull();
    expect(normalizeDetectionHost(42)).toBeNull();
    expect(normalizeDetectionHost('C:\\foo')).toBeNull();
  });
});

describe('sanitizeGitProviders', () => {
  test('normalizes a valid payload', () => {
    expect(sanitizeGitProviders({
      github: { apiBaseUrl: 'https://github.example.com/api/v3', detectUrls: ['https://github.example.com/owner/repo.git'] },
      gitlab: { apiBaseUrl: 'gitlab.example.com', detectUrls: [] },
      gitea: { apiBaseUrl: '', detectUrls: ['gitea.example.com'] },
    })).toEqual({
      github: { apiBaseUrl: 'https://github.example.com/api/v3', detectUrls: ['github.example.com'] },
      gitlab: { apiBaseUrl: 'https://gitlab.example.com' },
      gitea: { detectUrls: ['gitea.example.com'] },
    });
  });

  test('dedupes and lowercases detectUrls', () => {
    expect(sanitizeGitProviders({
      github: { detectUrls: ['GitHub.Example.com', 'https://github.example.com/x', 'other.example.com', 'other.example.com'] },
    })).toEqual({
      github: { detectUrls: ['github.example.com', 'other.example.com'] },
    });
  });

  test('drops malformed or empty entries', () => {
    expect(sanitizeGitProviders({ github: { apiBaseUrl: '   ' } })).toBeUndefined();
    expect(sanitizeGitProviders({ github: { detectUrls: 'not-an-array' } })).toBeUndefined();
    expect(sanitizeGitProviders({ unknown: { apiBaseUrl: 'https://x.example.com' } })).toBeUndefined();
    expect(sanitizeGitProviders('not-an-object')).toBeUndefined();
    expect(sanitizeGitProviders(null)).toBeUndefined();
    expect(sanitizeGitProviders([])).toBeUndefined();
  });

  test('ignores unknown provider keys', () => {
    expect(sanitizeGitProviders({
      github: { apiBaseUrl: 'https://github.example.com' },
      bitbucket: { apiBaseUrl: 'https://bitbucket.example.com' },
    })).toEqual({
      github: { apiBaseUrl: 'https://github.example.com' },
    });
  });
});

describe('readGitProvidersConfig / getProviderApiBaseUrl', () => {
  test('returns {} / defaults when no settings file exists', () => {
    expect(readGitProvidersConfig()).toEqual({});
    expect(getProviderApiBaseUrl('github')).toBe('https://api.github.com');
    expect(getProviderApiBaseUrl('gitlab')).toBe('https://gitlab.com');
    expect(getProviderApiBaseUrl('gitea')).toBe('https://codeberg.org');
  });

  test('reads the configured values from settings.json', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      gitProviders: {
        github: { apiBaseUrl: 'https://github.example.com/api/v3' },
        gitlab: { apiBaseUrl: 'https://gitlab.example.com' },
      },
    }));
    expect(readGitProvidersConfig()).toEqual({
      github: { apiBaseUrl: 'https://github.example.com/api/v3' },
      gitlab: { apiBaseUrl: 'https://gitlab.example.com' },
    });
    expect(getProviderApiBaseUrl('github')).toBe('https://github.example.com/api/v3');
    expect(getProviderApiBaseUrl('gitlab')).toBe('https://gitlab.example.com');
    expect(getProviderApiBaseUrl('gitea')).toBe('https://codeberg.org');
  });

  test('never throws on a malformed settings file', () => {
    fs.writeFileSync(SETTINGS_FILE, '{not-json');
    expect(readGitProvidersConfig()).toEqual({});
    expect(getProviderApiBaseUrl('github')).toBe(GIT_PROVIDER_DEFAULTS.github);
  });
});

describe('getProviderDetectUrls', () => {
  test('returns the built-in default hosts when nothing is configured', () => {
    expect(getProviderDetectUrls('github')).toEqual(['github.com']);
    expect(getProviderDetectUrls('gitlab')).toEqual(['gitlab.com']);
    expect(getProviderDetectUrls('gitea')).toEqual(['codeberg.org']);
    expect(GIT_PROVIDER_DEFAULT_DETECT_URLS.gitea).toEqual(['codeberg.org']);
  });

  test('keeps the built-in hosts and appends configured detectUrls', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      gitProviders: {
        github: { detectUrls: ['github.example.com'] },
        gitea: { detectUrls: ['gitea.example.com', 'codeberg.org'] },
      },
    }));
    expect(getProviderDetectUrls('github')).toEqual(['github.com', 'github.example.com']);
    expect(getProviderDetectUrls('gitea')).toEqual(['codeberg.org', 'gitea.example.com']);
  });
});

describe('githubWebOriginFromApiBase', () => {
  test('maps the public api host to github.com', () => {
    expect(githubWebOriginFromApiBase('https://api.github.com')).toBe('https://github.com');
  });

  test('maps enterprise api bases to the host', () => {
    expect(githubWebOriginFromApiBase('https://github.example.com/api/v3')).toBe('https://github.example.com');
    expect(githubWebOriginFromApiBase('https://github.example.com/api')).toBe('https://github.example.com');
  });

  test('keeps subpath prefixes and plain origins', () => {
    expect(githubWebOriginFromApiBase('https://github.example.com/ghe/api/v3')).toBe('https://github.example.com/ghe');
    expect(githubWebOriginFromApiBase('https://github.example.com')).toBe('https://github.example.com');
    expect(githubWebOriginFromApiBase('https://github.example.com:8443/api/v3')).toBe('https://github.example.com:8443');
  });

  test('falls back for invalid input and never throws', () => {
    expect(githubWebOriginFromApiBase('')).toBe('https://github.com');
    expect(githubWebOriginFromApiBase(null)).toBe('https://github.com');
    expect(githubWebOriginFromApiBase('not a url')).toBe('https://github.com');
  });
});

describe('isSafeEndpointUrl', () => {
  test('accepts HTTPS public hostnames', () => {
    expect(isSafeEndpointUrl('https://github.com')).toBe(true);
    expect(isSafeEndpointUrl('https://gitlab.example.com/api/v4')).toBe(true);
    expect(isSafeEndpointUrl('https://codeberg.org')).toBe(true);
    expect(isSafeEndpointUrl('https://gitea.mycompany.com:8443')).toBe(true);
  });

  test('rejects HTTP', () => {
    expect(isSafeEndpointUrl('http://github.com')).toBe(false);
    expect(isSafeEndpointUrl('http://localhost:8080')).toBe(false);
  });

  test('rejects non-https protocols', () => {
    expect(isSafeEndpointUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeEndpointUrl('ftp://example.com')).toBe(false);
  });

  test('rejects loopback addresses', () => {
    expect(isSafeEndpointUrl('https://localhost')).toBe(false);
    expect(isSafeEndpointUrl('https://localhost:3000')).toBe(false);
    expect(isSafeEndpointUrl('https://127.0.0.1')).toBe(false);
    expect(isSafeEndpointUrl('https://127.0.0.1:8080')).toBe(false);
    expect(isSafeEndpointUrl('https://[::1]')).toBe(false);
  });

  test('rejects private IPv4 addresses', () => {
    expect(isSafeEndpointUrl('https://10.0.0.1')).toBe(false);
    expect(isSafeEndpointUrl('https://10.255.255.255')).toBe(false);
    expect(isSafeEndpointUrl('https://172.16.0.1')).toBe(false);
    expect(isSafeEndpointUrl('https://172.31.255.255')).toBe(false);
    expect(isSafeEndpointUrl('https://192.168.1.1')).toBe(false);
    expect(isSafeEndpointUrl('https://192.168.0.254')).toBe(false);
  });

  test('rejects link-local addresses', () => {
    expect(isSafeEndpointUrl('https://169.254.1.1')).toBe(false);
    expect(isSafeEndpointUrl('https://[fe80::1]')).toBe(false);
  });

  test('rejects IPv6 unique-local addresses', () => {
    expect(isSafeEndpointUrl('https://[fc00::1]')).toBe(false);
    expect(isSafeEndpointUrl('https://[fd00::1]')).toBe(false);
  });

  test('rejects IPv4-mapped IPv6 loopback/private', () => {
    expect(isSafeEndpointUrl('https://[::ffff:127.0.0.1]')).toBe(false);
    expect(isSafeEndpointUrl('https://[::ffff:10.0.0.1]')).toBe(false);
    expect(isSafeEndpointUrl('https://[::ffff:192.168.1.1]')).toBe(false);
  });

  test('rejects invalid or empty input', () => {
    expect(isSafeEndpointUrl('')).toBe(false);
    expect(isSafeEndpointUrl('not a url')).toBe(false);
    expect(isSafeEndpointUrl(null)).toBe(false);
    expect(isSafeEndpointUrl(undefined)).toBe(false);
  });
});
