import { describe, expect, it } from 'vitest';
import { parseRequest } from './validation.js';

const id = '123456abcdef';
const spec = { id, name: 'Test, a=b', project: '1234567890abcdef', created: '2026-11-06T00:00:00.000Z', memoryBytes: 1024 ** 3 };
const create = { op: 'create', place: 'host', spec, startConfig: null, toolsKey: '1234567890abcdef' };

describe('hostd request boundary', () => {
  it('produces a fresh spec containing only the authorized intent', () => {
    const result = parseRequest(create);
    expect(result).toEqual(create);
    expect(result.spec).not.toBe(spec);
  });
  it.each(['unit', 'uid', 'mounts', 'namespace', 'path', '__proto__'])('rejects caller-selected %s', (field) => {
    const request = JSON.parse(JSON.stringify(create).slice(0, -1) + `,"${field}":"root"}`);
    expect(() => parseRequest(request)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
  it.each([
    { id: '../root' }, { id: 'ABCDEF123456' }, { memoryBytes: -1 }, { memoryBytes: 2 ** 53 },
    { created: 'yesterday' }, { purpose: 'root' }, { project: '/home/dev' }, { name: 'hello\nUser=root' }, { extra: true },
  ])('rejects a malformed immutable spec %j', (change) => {
    expect(() => parseRequest({ ...create, spec: { ...spec, ...change } })).toThrow();
  });
  it.each([[], [''], ['id', 'a\0b'], ['id', 5], Array(257).fill('x')])('rejects malformed argv %j', (argv) => {
    expect(() => parseRequest({ op: 'exec', place: 'host', id, target: 'space', argv })).toThrow();
  });
  it('preserves shell metacharacters as command data', () => {
    const argv = ['/bin/sh', '-c', 'printf "%s" "$HOME;$(id)\n"'];
    expect(parseRequest({ op: 'exec', place: 'host', id, target: 'space', argv }).argv).toEqual(argv);
  });
  it('rejects a provider key in start configuration', () => {
    const startConfig = JSON.stringify({ providers: { acme: { settings: { baseURL: 'http://gatekeeper:8080/model/acme', apiKey: 'real-key' } } } });
    expect(() => parseRequest({ ...create, startConfig })).toThrow();
  });
  it('allows only the matching window and placeholder configuration', () => {
    const startConfig = JSON.stringify({ providers: { acme: { settings: { baseURL: 'http://gatekeeper:8080/model/acme', apiKey: 'space-window' } } } });
    expect(parseRequest({ ...create, startConfig }).startConfig).toBe(startConfig);
  });
  it.each([0, 4 * 3600_000 + 1, NaN])('rejects an uncapped exec duration %s', (timeoutMs) => {
    expect(() => parseRequest({ op: 'exec', place: 'host', id, target: 'space', argv: ['id'], timeoutMs })).toThrow();
  });
  it('accepts inline and framed tools input without accepting arbitrary encodings', () => {
    expect(parseRequest({ op: 'tools-ensure', key: create.toolsKey, input: null }).input).toBeNull();
    expect(parseRequest({ op: 'tools-ensure', key: create.toolsKey, input: 'YQ==' }).input).toBe('YQ==');
    expect(() => parseRequest({ op: 'tools-ensure', key: create.toolsKey, input: 'YQ=\n' })).toThrow();
  });
});
