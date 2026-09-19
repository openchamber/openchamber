import { describe, expect, test } from 'bun:test';

import { browserProviderResultSchema } from './service-provider-schemas.ts';
import { BROWSER_CONTROL_ACTIONS, isBrowserControlAction, readBrowserProviderRequest } from './service-providers.ts';

describe('browser provider contract', () => {
  test('reads the body the host posts and refuses anything else', () => {
    const body = JSON.stringify({ requestId: 'req-1', action: 'browser.click', parameters: { selector: '#save' } });
    expect(readBrowserProviderRequest(body)).toEqual({ requestId: 'req-1', action: 'browser.click', parameters: { selector: '#save' } });

    expect(readBrowserProviderRequest('not json')).toBeNull();
    expect(readBrowserProviderRequest('null')).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: '', action: 'browser.click', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.explode', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.back' }))).toBeNull();
  });

  test('the action list is the tool\'s ten browser actions', () => {
    expect(BROWSER_CONTROL_ACTIONS).toHaveLength(10);
    expect(isBrowserControlAction('browser.snapshot')).toBe(true);
    expect(isBrowserControlAction('projects.list')).toBe(false);
  });

  test('the host accepts ok/data and ok/error answers only', () => {
    expect(browserProviderResultSchema.safeParse({ ok: true, data: { url: 'http://a/' } }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: 'No element matches #x' }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: '' }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ data: {} }).success).toBe(false);
  });
});
