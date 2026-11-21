import { describe, expect, test } from 'bun:test';
import { parseBrowserControlEvent } from './controlEvents';

const requestEnvelope = (properties: Record<string, unknown>) => ({ type: 'openchamber:browser-control-request', properties });

describe('reading browser control events off the stream', () => {
  test('a request from a server that predates the preferred window names no window', () => {
    expect(parseBrowserControlEvent(requestEnvelope({
      requestId: 'req-1',
      action: 'browser.open',
      parameters: { url: 'https://example.com' },
      context: { directory: '/repo', sessionId: 'ses_1' },
    }))).toEqual({
      type: 'browser-control-request',
      requestId: 'req-1',
      action: 'browser.open',
      parameters: { url: 'https://example.com' },
      context: { directory: '/repo', sessionId: 'ses_1' },
      preferredConnectionId: null,
    });
  });

  test('a request keeps its id and action when its parameters and context are unusable', () => {
    expect(parseBrowserControlEvent(requestEnvelope({
      requestId: 'req-1',
      action: 'browser.snapshot',
      parameters: ['not', 'an', 'object'],
      preferredConnectionId: 'desktop',
    }))).toEqual({
      type: 'browser-control-request',
      requestId: 'req-1',
      action: 'browser.snapshot',
      parameters: {},
      context: { directory: null, sessionId: null },
      preferredConnectionId: 'desktop',
    });
  });

  test('a request without an id or an action is dropped', () => {
    expect(parseBrowserControlEvent(requestEnvelope({ requestId: '', action: 'browser.open' }))).toBeNull();
    expect(parseBrowserControlEvent(requestEnvelope({ requestId: 'req-1' }))).toBeNull();
  });

  test('reads which window became the preferred one', () => {
    expect(parseBrowserControlEvent({ type: 'openchamber:browser-control-preferred', properties: { connectionId: 'desktop' } }))
      .toEqual({ type: 'browser-control-preferred', connectionId: 'desktop' });
    expect(parseBrowserControlEvent({ type: 'openchamber:browser-control-preferred', properties: {} })).toBeNull();
  });
});
