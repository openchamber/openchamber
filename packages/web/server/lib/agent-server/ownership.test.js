import { describe, expect, it } from 'vitest';
import { classify, OWNERSHIP } from './ownership.js';
import { readAgentServerMode } from './mode.js';

const request = (url, method = 'GET', headers = {}) => ({ url, method, headers });

describe('front door ownership', () => {
  it('enumerates every method/path rule without an ambiguous duplicate', () => {
    // Given the exported table used by the classifier.
    const seen = new Set();
    for (const rule of OWNERSHIP) for (const method of rule.methods) {
      // When its representative request is classified.
      const key = `${method} ${rule.path} ${Boolean(rule.upgrade)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      const actualMethod = method === '*' ? 'GET' : method;
      // Then each concrete rule selects its declared owner.
      if (rule.path === '/api' || rule.path === '/api/system' || rule.path === '/api/spaces') continue;
      expect(classify(request(rule.path, actualMethod, rule.upgrade ? { upgrade: 'websocket' } : {}))).toBe(rule.owner);
    }
    expect([...seen].filter((key) => key.includes('/api/system'))).toEqual([
      'GET /api/system/info false', 'HEAD /api/system/info false', 'GET /api/system/stats false', 'HEAD /api/system/stats false',
      'POST /api/system/shutdown false', 'POST /api/system/dev-shutdown false', 'GET /api/system/free-port false', 'HEAD /api/system/free-port false',
      'POST /api/system/probe-url false', '* /api/system false',
    ]);
    expect([...seen].filter((key) => key.includes('/api/tracked-items'))).toEqual([
      'POST /api/tracked-items/interest false', 'POST /api/tracked-items/presence false',
    ]);
  });
  it.each([
    ['/API/CONFIG/SETTINGS', 'PUT', 'local'], ['/api/session/../config/settings', 'PUT', 'local'],
    ['/api/%63onfig/settings', 'PUT', 'local'], ['/api/config/settings/', 'GET', 'local'],
    ['/api/config/settings-extra', 'PUT', 'agent'], ['/api/config/settings', 'POST', 'agent'],
    ['/api//config/settings', 'PUT', 'refused'], ['/api/config%2fsettings', 'PUT', 'refused'],
    ['/api/config%252fsettings', 'PUT', 'refused'], ['/api/\\config/settings', 'PUT', 'refused'],
    ['/api/config/%ZZ', 'GET', 'refused'], ['/api/system/future-kill', 'POST', 'refused'],
    ['/api/git/status?directory=/spaces/012345abcdef/repo', 'GET', 'space'],
    ['/api/future', 'GET', 'agent'],
    ['/api/tracked-items/interest', 'POST', 'local'], ['/api/tracked-items/presence', 'POST', 'local'],
    ['/api/tracked-items/refresh', 'POST', 'agent'], ['/api/tracked-items/interest', 'GET', 'agent'],
  ])('classifies %s with method %s as %s', (url, method, expected) => {
    // Given an alternate spelling or method. When classified, then ownership is stable.
    expect(classify(request(url, method))).toBe(expected);
  });
  it.each([
    ['/api/event/ws', 'local'], ['/api/global/event/ws', 'local'],
    ['/api/terminal/ws', 'agent'], ['/api/dev-tunnel', 'agent'],
    ['/api/dictation/ws', 'refused'], ['/other', 'refused'],
  ])('classifies upgrade %s as %s', (url, expected) => {
    // Given a socket handshake. When classified, then only explicit upgrades pass.
    expect(classify(request(url, 'GET', { upgrade: 'websocket' }))).toBe(expected);
  });
  it('keeps owner settings and local message sockets local with a carried space directory', () => {
    // Given the directory header an SDK retains while a space is selected.
    const headers = { 'x-opencode-directory': '/spaces/012345abcdef/repo' };
    // When a local service is selected, then its parser and socket handler keep ownership.
    expect(classify(request('/api/config/settings', 'PUT', headers))).toBe('local');
    expect(classify(request('/api/event/ws', 'GET', { ...headers, upgrade: 'websocket' }))).toBe('local');
    expect(classify(request('/api/system/shutdown', 'POST', headers))).toBe('refused');
    // Project operations still use the existing Space forwarding guards.
    expect(classify(request('/api/git/status', 'GET', headers))).toBe('space');
  });
});

describe('agent server mode', () => {
  it.each(['https://127.0.0.1:3000', 'http://example.com', 'http://127.0.0.1:3000/api', 'http://u:p@localhost:3000', 'file:///tmp/agent'])('refuses upstream %s before startup', (url) => {
    // Given an unsafe origin. When mode is read, then startup fails closed.
    expect(() => readAgentServerMode({ OPENCHAMBER_AGENT_SERVER_URL: url, OPENCHAMBER_AGENT_SERVER_TOKEN: 'test' })).toThrow(/loopback HTTP/);
  });
  it('requires both upstream settings', () => {
    // Given partial configuration. When read, then no local fallback is selected.
    expect(() => readAgentServerMode({ OPENCHAMBER_AGENT_SERVER_URL: 'http://localhost:3000' })).toThrow(/requires/);
  });
  it('preserves single server mode when unset', () => {
    // Given no separation settings. When read, then both special modes are off.
    expect(readAgentServerMode({})).toEqual({ frontDoor: false, agent: false, upstream: null });
  });
});
