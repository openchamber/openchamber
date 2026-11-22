import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { useOpenCodeModelSettings, type OpenCodeModelSettings } from './opencodeModelSettings';

// Oracle: the route contract in packages/web/server/lib/opencode/routes.js
// (`/api/config/opencode-model-settings`) and the rule that a failed read is
// never shown as an empty set.

type Sent = { url: string; method: string; body: string };
const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });
// What the route answers: the settings it read, or why it refused.
type RouteAnswer = { path: string; writable: boolean; models: Record<string, OpenCodeModelSettings> } | { error: string };
const json = (body: RouteAnswer, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sent.length = 0;
  useOpenCodeModelSettings.setState({ status: 'idle', path: null, writable: false, models: {}, error: null });
  spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request: Sent = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : '' };
    sent.push(request);
    return respond(request);
  });
});

afterEach(() => {
  mock.restore();
});

describe('OpenCode model settings store', () => {
  test('a server without the route reads as unavailable', async () => {
    respond = () => new Response('', { status: 404 });
    await useOpenCodeModelSettings.getState().load();
    expect(useOpenCodeModelSettings.getState().status).toBe('unavailable');
  });

  test('a failed read keeps the settings already loaded instead of emptying them', async () => {
    respond = () => json({ path: '/u/opencode.json', writable: true, models: { 'p/m': { hidden: true } } });
    await useOpenCodeModelSettings.getState().load();
    expect(useOpenCodeModelSettings.getState().models).toEqual({ 'p/m': { hidden: true } });
    respond = () => json({ error: 'disk on fire' }, 500);
    await useOpenCodeModelSettings.getState().load();
    expect(useOpenCodeModelSettings.getState()).toMatchObject({ status: 'failed', error: 'disk on fire', models: { 'p/m': { hidden: true } } });
  });

  test('a change is sent for one model and the answer replaces the state; a refused one throws', async () => {
    respond = () => json({ path: '/u/opencode.json', writable: true, models: { 'p/m': { defaultVariant: 'high' } } });
    await useOpenCodeModelSettings.getState().save('p', 'm', { defaultVariant: 'high', lockVariant: null });
    expect(sent.at(-1)?.method).toBe('PUT');
    expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toEqual({ providerID: 'p', modelID: 'm', settings: { defaultVariant: 'high', lockVariant: null } });
    expect(useOpenCodeModelSettings.getState().models).toEqual({ 'p/m': { defaultVariant: 'high' } });
    respond = () => json({ error: 'enterprise' }, 403);
    await expect(useOpenCodeModelSettings.getState().save('p', 'm', { hidden: true })).rejects.toThrow('enterprise');
    expect(useOpenCodeModelSettings.getState().models).toEqual({ 'p/m': { defaultVariant: 'high' } });
  });
});
