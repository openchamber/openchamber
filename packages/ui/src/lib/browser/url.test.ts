import { describe, expect, test } from 'bun:test';

import { BLANK_URL, browserUrlLabel, isLoopbackUrl, isStartingServerFailure, normalizeBrowserUrl } from './url';

describe('normalizeBrowserUrl', () => {
  test('keeps an explicit scheme', () => {
    expect(normalizeBrowserUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(normalizeBrowserUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  test('defaults a public host to https', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
  });

  test('defaults a loopback authority to http, since dev servers speak plain http', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app');
    expect(normalizeBrowserUrl('localhost')).toBe('http://localhost/');
    expect(normalizeBrowserUrl('openchamber-preview.localhost:52418')).toBe('http://openchamber-preview.localhost:52418/');
  });

  test('does not mistake a public host that merely starts with a loopback-looking label', () => {
    expect(normalizeBrowserUrl('localhost.example.com')).toBe('https://localhost.example.com/');
    expect(normalizeBrowserUrl('openchamber-preview.localhost.example.com')).toBe('https://openchamber-preview.localhost.example.com/');
  });

  test('rejects non-http schemes rather than handing them to the browser', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('javascript://alert(1)')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('data://text/html,x')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('data:text/html,<p>hi</p>')).toBe(BLANK_URL);
  });

  test('treats empty input, a blank page and an unparseable address as blank', () => {
    expect(normalizeBrowserUrl('')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('   ')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl('http://')).toBe(BLANK_URL);
    expect(normalizeBrowserUrl(BLANK_URL)).toBe(BLANK_URL);
  });

  test('searches the web for text that is not an address', () => {
    expect(normalizeBrowserUrl('react hooks')).toBe('https://www.google.com/search?q=react%20hooks');
    expect(normalizeBrowserUrl('react hooks https://react.dev')).toBe('https://www.google.com/search?q=react%20hooks%20https%3A%2F%2Freact.dev');
    expect(normalizeBrowserUrl('  vite  ')).toBe('https://www.google.com/search?q=vite');
    expect(normalizeBrowserUrl('c++ & rust?')).toBe('https://www.google.com/search?q=c%2B%2B%20%26%20rust%3F');
    expect(normalizeBrowserUrl('what is localhost:3000')).toBe('https://www.google.com/search?q=what%20is%20localhost%3A3000');
  });

  test('keeps anything shaped like a host an address', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('example.com/docs?q=1')).toBe('https://example.com/docs?q=1');
    expect(normalizeBrowserUrl('192.168.1.20:8080')).toBe('https://192.168.1.20:8080/');
    expect(normalizeBrowserUrl('[::1]:5173')).toBe('http://[::1]:5173/');
    expect(normalizeBrowserUrl('[2001:db8::1]')).toBe('https://[2001:db8::1]/');
    expect(normalizeBrowserUrl('devbox:8080')).toBe('https://devbox:8080/');
    expect(normalizeBrowserUrl('myapp.localhost:1355')).toBe('https://myapp.localhost:1355/');
  });
});

describe('isLoopbackUrl', () => {
  test('recognizes loopback hosts', () => {
    expect(isLoopbackUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1/')).toBe(true);
    expect(isLoopbackUrl('http://openchamber-preview.localhost:52418/')).toBe(true);
  });

  test('rejects remote hosts and garbage', () => {
    expect(isLoopbackUrl('https://example.com/')).toBe(false);
    expect(isLoopbackUrl('nonsense')).toBe(false);
    expect(isLoopbackUrl('http://openchamber-preview.localhost.example.com/')).toBe(false);
    expect(isLoopbackUrl('https://auth.myapp.localhost/')).toBe(false);
  });
});

describe('browserUrlLabel', () => {
  test('shows host and port', () => {
    expect(browserUrlLabel('http://localhost:5173/a/b')).toBe('localhost:5173');
  });

  test('is empty for a blank page', () => {
    expect(browserUrlLabel(BLANK_URL)).toBe('');
    expect(browserUrlLabel('')).toBe('');
  });
});

describe('isStartingServerFailure', () => {
  test('retries a loopback connection refusal, the usual "server not up yet"', () => {
    expect(isStartingServerFailure(-102, 'http://localhost:3000/')).toBe(true);
    expect(isStartingServerFailure(-104, 'http://127.0.0.1:5173/')).toBe(true);
    expect(isStartingServerFailure(-102, 'http://openchamber-preview.localhost:52418/')).toBe(true);
  });

  test('retries a name under localhost, where a local proxy serves a project', () => {
    expect(isStartingServerFailure(-102, 'http://myapp.localhost:1355/')).toBe(true);
    expect(isStartingServerFailure(-102, 'https://auth.myapp.localhost/')).toBe(true);
  });

  test('does not retry a public host that refused the connection', () => {
    expect(isStartingServerFailure(-102, 'https://example.com/')).toBe(false);
    expect(isStartingServerFailure(-102, 'https://myapp.localhost.example.com/')).toBe(false);
  });

  test('does not retry a real page-level failure', () => {
    // ERR_ABORTED and certificate errors are not "not up yet".
    expect(isStartingServerFailure(-3, 'http://localhost:3000/')).toBe(false);
    expect(isStartingServerFailure(-201, 'http://localhost:3000/')).toBe(false);
  });

  test('does not retry an unparseable url', () => {
    expect(isStartingServerFailure(-102, 'not-a-url')).toBe(false);
  });
});
