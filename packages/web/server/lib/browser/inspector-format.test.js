import { describe, expect, it } from 'vitest';
import { boundedString, formatConsoleEvent, formatHeaders, formatRemoteObject, normalizeBody, redactUrl } from './inspector-format.js';

describe('inspector formatting', () => {
  it('parses strings without coercing malformed payloads', () => {
    expect(boundedString('abc', 2)).toBe('ab');
    expect(boundedString({ text: 'private' }, 100, 'missing')).toBe('missing');
    expect(boundedString(null, 100)).toBe('');
  });

  it.each([
    [{ type: 'string', value: 'hello' }, 'hello'],
    [{ type: 'number', value: 42 }, '42'],
    [{ type: 'number', unserializableValue: 'NaN' }, 'NaN'],
    [{ type: 'boolean', value: false }, 'false'],
    [{ type: 'undefined' }, 'undefined'],
    [{ type: 'object', subtype: 'null', value: null }, 'null'],
    [{ type: 'bigint', unserializableValue: '12n' }, '12n'],
  ])('formats primitive CDP values %j', (input, text) => {
    expect(formatRemoteObject(input)).toEqual({ text, truncated: false });
  });

  it('shapes useful previews without remote object IDs or arbitrary fields', () => {
    const output = formatRemoteObject({ type: 'object', objectId: 'secret-id', unexpected: 'private',
      preview: { type: 'object', description: 'Object', properties: [
        { name: 'count', type: 'number', value: '2' },
        { name: 'name', type: 'string', value: 'Ada' },
        { name: 'password', type: 'string', value: 'private-password' },
      ] } });
    expect(output.text).toBe('{count: 2, name: "Ada", password: [REDACTED]}');
    expect(output.text).not.toContain('secret-id');
    expect(output.text).not.toContain('private');
  });

  it('marks both character limits and Chrome preview overflow', () => {
    expect(formatRemoteObject({ type: 'string', value: 'a'.repeat(4001) })).toEqual({ text: 'a'.repeat(4000), truncated: true });
    expect(formatRemoteObject({ type: 'object', preview: { overflow: true, properties: [] } }).truncated).toBe(true);
    expect(formatRemoteObject(null)).toEqual({ text: 'undefined', truncated: false });
    expect(formatRemoteObject({ type: 'string', value: `https://user:password@example.test/?token=${'a'.repeat(4000)}` }).truncated).toBe(true);
  });

  it('redacts credential URLs before bounding the result', () => {
    const value = redactUrl('https://username:password@example.test/api?keep=yes&access_token=private-token&API-Key=private-key#access_token=private-fragment');
    expect(value).toContain('keep=yes');
    expect(value).not.toMatch(/username|password|private/);
    expect(redactUrl(`https://user:password@example.test/${'a'.repeat(2100)}`)).toHaveLength(2048);
    expect(redactUrl('https://user:secret@%%%?token=private')).not.toMatch(/user|secret|private/);
    expect(redactUrl('//user:secret@example.test/?token=private')).not.toMatch(/user|secret|private/);
    expect(redactUrl('data:text/html,private')).toBe('data:[redacted]');
    expect(redactUrl('VM123')).toBe('VM123');
  });

  it('redacts case-insensitive credential headers and bounds names, values and count', () => {
    const { headers } = formatHeaders({ Authorization: 'Bearer private', Cookie: 'session=private',
      'Set-Cookie': 'private', 'X-Api-Key': 'private', 'X-Auth-Token': 'private',
      Location: 'https://user:private@example.test/?token=private', 'Content-Type': 'application/json' });
    expect(headers.filter((header) => header.name !== 'Content-Type').every((header) => !header.value.includes('private'))).toBe(true);
    expect(headers.find((header) => header.name === 'Content-Type').value).toBe('application/json');
    const many = formatHeaders(Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`header-${index}`, 'a'.repeat(1100)])));
    expect(many.headers).toHaveLength(64);
    expect(many.truncated).toBe(true);
    expect(formatHeaders({ ['a'.repeat(300)]: 'a'.repeat(1100) })).toEqual({ headers: [{ name: 'a'.repeat(256), value: 'a'.repeat(1024) }], truncated: true });
    expect(formatHeaders(null)).toEqual({ headers: [], truncated: false });
    expect(formatHeaders('private')).toEqual({ headers: [], truncated: false });
    expect(formatHeaders({ 'Content-Type': 'text/plain' }).truncated).toBe(false);
  });

  it.each([
    ['/next?api_key=synthetic&keep=yes', '/next?api_key=%5BREDACTED%5D&keep=yes'],
    ['../next?token=synthetic&keep=yes', '../next?token=%5BREDACTED%5D&keep=yes'],
    ['?api_key=synthetic&keep=yes', '?api_key=%5BREDACTED%5D&keep=yes'],
    ['#access_token=synthetic&keep=yes', '#access_token=%5BREDACTED%5D&keep=yes'],
    ['#/next?token=synthetic&keep=yes', '#/next?token=%5BREDACTED%5D&keep=yes'],
    ['#section', '#section'],
  ])('redacts relative URL-valued headers %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
    for (const name of ['Location', 'referer', 'CONTENT-LOCATION']) {
      expect(formatHeaders({ [name]: input })).toEqual({ headers: [{ name, value: expected }], truncated: false });
    }
  });

  it.each([-1, 8.64e15 + 1, Infinity, NaN, '1000'])('replaces invalid console timestamps %s', (timestamp) => {
    const before = Date.now();
    for (const method of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']) {
      const result = formatConsoleEvent(method, { timestamp }, 'valid-row');
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    }
    for (const valid of [0, 8.64e15]) expect(formatConsoleEvent('Runtime.consoleAPICalled', { timestamp: valid }, 'valid-row').timestamp).toBe(valid);
  });

  it('formats console calls with useful source and bounded text', () => {
    expect(formatConsoleEvent('Runtime.consoleAPICalled', { type: 'warn', timestamp: 1000,
      args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 2 }],
      stackTrace: { callFrames: [{ url: 'https://user:secret@example.test/a.js?token=private', lineNumber: 4 }] },
    }, 'row-1')).toEqual({ id: 'row-1', timestamp: 1000, level: 'warning', text: 'hello 2',
      source: 'https://example.test/a.js?token=%5BREDACTED%5D', line: 4, truncated: false });
    const long = formatConsoleEvent('Runtime.consoleAPICalled', { type: 'table', args: Array.from({ length: 30 }, () => ({ type: 'string', value: 'a'.repeat(300) })) }, 'row-2');
    expect(long.text).toHaveLength(4000);
    expect(long.truncated).toBe(true);
    expect(long.level).toBe('log');
    expect(formatConsoleEvent('Runtime.consoleAPICalled', { type: { toString: null }, args: [null] }, 'row-3').level).toBe('log');
  });

  it('includes Runtime exceptions once with fixed output keys', () => {
    const input = { timestamp: 1001, exceptionDetails: { text: 'Uncaught', lineNumber: 0,
      url: 'https://example.test/script.js', exception: { type: 'object', subtype: 'error', description: 'Error: broken', objectId: 'private-id' } } };
    expect(formatConsoleEvent('Runtime.exceptionThrown', input, 'error-1')).toEqual({ id: 'error-1', timestamp: 1001,
      level: 'error', text: 'Error: broken', source: 'https://example.test/script.js', line: 0, truncated: false });
    expect(formatConsoleEvent('Log.entryAdded', input, 'error-1')).toBeNull();
  });
});

describe('inspector textual bodies', () => {
  it.each(['text/plain', 'application/json', 'application/problem+json', 'application/javascript', 'application/xml', 'image/svg+xml', 'application/x-www-form-urlencoded'])('accepts textual MIME %s', (mime) => {
    expect(normalizeBody('hello', false, mime)).toEqual({ text: 'hello', truncated: false, supported: true });
  });

  it.each(['image/png', 'application/octet-stream', 'audio/mpeg', ''])('rejects nontextual MIME %s', (mime) => {
    expect(normalizeBody('private', false, mime)).toEqual({ text: null, truncated: false, supported: false });
  });

  it('decodes base64 UTF-8 and rejects invalid encoding', () => {
    expect(normalizeBody(Buffer.from('hello 🌍').toString('base64'), true, 'text/plain').text).toBe('hello 🌍');
    expect(normalizeBody('/w==', true, 'text/plain').supported).toBe(false);
    expect(normalizeBody('%%%invalid', true, 'text/plain').supported).toBe(false);
    expect(normalizeBody('hello', false, 'text/plain; charset=iso-8859-1').supported).toBe(false);
    expect(normalizeBody(null, false, 'text/plain').supported).toBe(false);
    expect(normalizeBody(Buffer.from('🌍'.repeat(20000)).toString('base64'), true, 'text/plain')).toEqual({ text: '🌍'.repeat(4000), truncated: true, supported: true });
  });

  it('redacts JSON credential fields including nested values and escaped keys', () => {
    const body = '{"user":"Ada","password":"private","nested":{"access_token":"private-token"},"credentials":{"key":"private-key"},"client\\u0053ecret":"private-escaped","items":[1,2]}';
    const result = normalizeBody(body, false, 'application/json');
    expect(result.supported).toBe(true);
    expect(result.text).not.toContain('private');
    expect(JSON.parse(result.text)).toEqual({ user: 'Ada', password: '[REDACTED]', nested: { access_token: '[REDACTED]' }, credentials: '[REDACTED]', clientSecret: '[REDACTED]', items: [1, 2] });
  });

  it('redacts form credentials and preserves ordinary fields', () => {
    const result = normalizeBody('name=Ada&password=private&api%5Fkey=private-key&state=ready', false, 'application/x-www-form-urlencoded');
    expect(result.text).not.toContain('private');
    expect(new URLSearchParams(result.text).get('name')).toBe('Ada');
    expect(new URLSearchParams(result.text).get('state')).toBe('ready');
  });

  it('bounds bodies even when a sensitive JSON string crosses the cutoff', () => {
    expect(normalizeBody('a'.repeat(8001), false, 'text/plain')).toEqual({ text: 'a'.repeat(8000), truncated: true, supported: true });
    const result = normalizeBody(`{"safe":"${'a'.repeat(7900)}","password":"${'private'.repeat(1000)}"}`, false, 'application/json');
    expect(result.text.length).toBeLessThanOrEqual(8000);
    expect(result.text).not.toContain('private');
    expect(result.truncated).toBe(true);
  });
});
