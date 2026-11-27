import { describe, expect, it } from 'vitest';

import { parseListenerAddresses, parseUpstreamLog } from './docker-live-support.js';
import { parseIntegrationConnections, parsePluginList, sessionCookieOf } from './escape-answers.js';
import { parseProbeAnswers, parseTunnelCounts, parseWindowSeen } from './escape-suite.js';

const seen = { method: 'GET', path: '/v1/messages', authorization: 'none', apiKey: 'sha256:00', team: 'none', headerNames: ['host'] };

describe('answers the escape suite reads from inside a space', () => {
  it('refuses a probe answer that is not text, so connected() cannot skip it', () => {
    expect(parseProbeAnswers('{"10.0.0.1":"connected:10.0.0.1","host":"failed:ENOTFOUND"}')).toEqual({ '10.0.0.1': 'connected:10.0.0.1', host: 'failed:ENOTFOUND' });
    expect(() => parseProbeAnswers('{"10.0.0.1":{"connected":true}}')).toThrow();
    expect(() => parseProbeAnswers('["connected:10.0.0.1"]')).toThrow();
    expect(() => parseProbeAnswers('{"10.0.0.1":""}')).toThrow();
    expect(() => parseProbeAnswers('{"10.0.0.1":"refused"}')).toThrow();
  });

  it('refuses a window answer without the fields the key checks compare, and keeps every other field', () => {
    expect(parseWindowSeen(`200 ${JSON.stringify({ ...seen, leaked: 'x' })}`)).toMatchObject({ apiKey: 'sha256:00', leaked: 'x' });
    expect(() => parseWindowSeen(`200 ${JSON.stringify({ ...seen, headerNames: 'authorization' })}`)).toThrow();
    expect(() => parseWindowSeen(`200 ${JSON.stringify({ ...seen, apiKey: undefined })}`)).toThrow();
  });

  it('refuses tunnel counts that are not counts of the 80 attempts', () => {
    expect(parseTunnelCounts('done:{"established":64,"refused":16,"unreachable":0,"failed":0}')).toEqual({ established: 64, refused: 16, unreachable: 0, failed: 0 });
    expect(() => parseTunnelCounts('done:{"established":"64","refused":16,"unreachable":0,"failed":0}')).toThrow();
    expect(() => parseTunnelCounts('done:{"established":-1,"refused":81,"unreachable":0,"failed":0}')).toThrow();
    expect(() => parseTunnelCounts('done:{"established":1,"refused":1,"unreachable":0,"failed":0}')).toThrow();
    expect(() => parseTunnelCounts('{"established":64,"refused":16,"unreachable":0,"failed":0}')).toThrow('did not finish');
  });

  it('refuses an integration list whose connections are not a list', () => {
    expect(parseIntegrationConnections('{"data":[{"id":"openai","connections":[{"type":"credential"}]}]}')).toEqual([{ id: 'openai', connections: [{ type: 'credential' }] }]);
    expect(() => parseIntegrationConnections('{"data":[{"id":"openai","connections":{"type":"credential"}}]}')).toThrow();
    expect(() => parseIntegrationConnections('{"data":{}}')).toThrow();
  });

  it('refuses a plugin list that is not a list, so a wrong answer never counts as loaded', () => {
    expect(parsePluginList('{"data":[{"id":"a"}]}')).toHaveLength(1);
    expect(parsePluginList('{"data":[]}')).toEqual([]);
    expect(() => parsePluginList('{"data":"plugins"}')).toThrow();
  });

  it('needs the session cookie the login answer sets', () => {
    expect(sessionCookieOf({ 'set-cookie': ['session=abc; Path=/; HttpOnly'] })).toBe('session=abc');
    expect(() => sessionCookieOf({})).toThrow('set no session cookie');
  });
});

describe('what the live helpers read from their own containers', () => {
  it('takes the host listener addresses only as a list of text', () => {
    expect(parseListenerAddresses('["192.168.5.15","172.17.0.1"]')).toEqual(['192.168.5.15', '172.17.0.1']);
    expect(parseListenerAddresses('starting')).toEqual([]);
    expect(() => parseListenerAddresses('["192.168.5.15",17]')).toThrow();
  });

  it('reads only the request lines of the upstream log and refuses a malformed one', () => {
    const line = `seen ${JSON.stringify(seen)}`;
    expect(parseUpstreamLog(`upstream listening\n${line}\n`)).toEqual([{ ...seen, line }]);
    const hidden = `seen ${JSON.stringify(seen).slice(0, -1)},"__proto__":{"key":"sk-leaked"}}`;
    expect(JSON.stringify(parseUpstreamLog(hidden))).toContain('sk-leaked');
    expect(() => parseUpstreamLog(`seen ${JSON.stringify({ ...seen, headerNames: null })}\n`)).toThrow();
  });
});
