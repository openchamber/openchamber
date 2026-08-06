import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.OPENCHAMBER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), `openchamber-jira-auth-${crypto.randomBytes(4).toString('hex')}-`),
);

const {
  getJiraConnection,
  setJiraConnection,
  clearJiraConnection,
  normalizeJiraBaseUrl,
  JIRA_AUTH_FILE,
} = await import('./auth.js');

describe('normalizeJiraBaseUrl', () => {
  it('accepts https origins and strips trailing slashes, query, and hash', () => {
    expect(normalizeJiraBaseUrl('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBaseUrl('https://acme.atlassian.net/?x=1#y')).toBe('https://acme.atlassian.net');
  });

  it('prepends https:// when the scheme is missing', () => {
    expect(normalizeJiraBaseUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });

  it('preserves Server/Data Center context paths', () => {
    expect(normalizeJiraBaseUrl('https://jira.corp.example/jira/')).toBe('https://jira.corp.example/jira');
  });

  it('rejects non-http(s) and unparseable values', () => {
    expect(normalizeJiraBaseUrl('ftp://x.example')).toBeNull();
    expect(normalizeJiraBaseUrl('')).toBeNull();
    expect(normalizeJiraBaseUrl(undefined)).toBeNull();
    expect(normalizeJiraBaseUrl('http://')).toBeNull();
  });
});

describe('Jira connection storage', () => {
  beforeEach(() => {
    clearJiraConnection();
  });

  it('returns null when nothing is stored', () => {
    expect(getJiraConnection()).toBeNull();
  });

  it('round-trips a cloud connection', () => {
    setJiraConnection({
      deployment: 'cloud',
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.example',
      apiToken: 'secret-token',
      user: { accountId: 'abc', displayName: 'Dev', emailAddress: 'dev@acme.example' },
    });
    const connection = getJiraConnection();
    expect(connection).toMatchObject({
      deployment: 'cloud',
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.example',
      apiToken: 'secret-token',
    });
    expect(connection.user.displayName).toBe('Dev');
    expect(typeof connection.createdAt).toBe('number');
  });

  it('round-trips a server connection without an email', () => {
    setJiraConnection({
      deployment: 'server',
      baseUrl: 'https://jira.corp.example/jira',
      apiToken: 'pat-token',
    });
    expect(getJiraConnection()).toMatchObject({
      deployment: 'server',
      baseUrl: 'https://jira.corp.example/jira',
      email: null,
      apiToken: 'pat-token',
    });
  });

  it('rejects a cloud connection without an email', () => {
    expect(() => setJiraConnection({
      deployment: 'cloud',
      baseUrl: 'https://acme.atlassian.net',
      apiToken: 'secret-token',
    })).toThrow(/Invalid Jira connection/);
  });

  it('rejects an invalid base URL', () => {
    expect(() => setJiraConnection({
      deployment: 'server',
      baseUrl: 'not a url at all //',
      apiToken: 'pat',
    })).toThrow(/Invalid Jira connection/);
  });

  it('treats malformed stored data as not connected', () => {
    fs.writeFileSync(JIRA_AUTH_FILE, '{not json', 'utf8');
    expect(getJiraConnection()).toBeNull();
  });

  it('clears the stored connection', () => {
    setJiraConnection({
      deployment: 'server',
      baseUrl: 'https://jira.corp.example',
      apiToken: 'pat-token',
    });
    expect(clearJiraConnection()).toBe(true);
    expect(getJiraConnection()).toBeNull();
    expect(fs.existsSync(JIRA_AUTH_FILE)).toBe(false);
  });
});
