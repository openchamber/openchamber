import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Spy } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import { getDefaultMagicPromptTemplate, loadMagicPrompts, resolveMagicPromptTemplate } from './magicPrompts';
import { switchRuntimeEndpoint } from './runtime-switch';

type Call = { url: URL; headers: Headers };

const json = (body: JsonValue, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
);

let calls: Call[] = [];
let respond: () => Response = () => json({ version: 1, overrides: {} });
let request: Spy<typeof fetch>;

beforeEach(() => {
  calls = [];
  switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
  request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    // A runtime switch refreshes its URL token; that request is not under test.
    if (url.pathname === '/auth/url-token') return json({ token: 'test-url-token', expiresAt: Date.now() + 60_000 });
    calls.push({ url, headers: new Headers(init?.headers) });
    return respond();
  });
});

afterEach(() => {
  request.mockRestore();
});

describe('resolveMagicPromptTemplate', () => {
  test('takes project, then global, then built-in text, and an empty override is a value', () => {
    const layers = {
      project: new Map([['plan.todo.instructions', '']]),
      global: new Map([['plan.todo.visible', 'global todo'], ['plan.todo.instructions', 'global steps']]),
    };

    expect(resolveMagicPromptTemplate(layers, 'plan.todo.instructions')).toEqual({ template: '', source: 'project' });
    expect(resolveMagicPromptTemplate(layers, 'plan.todo.visible')).toEqual({ template: 'global todo', source: 'global' });
    expect(resolveMagicPromptTemplate(layers, 'plan.improve.visible')).toEqual({
      template: getDefaultMagicPromptTemplate('plan.improve.visible'),
      source: 'builtin',
    });
  });
});

describe('loadMagicPrompts', () => {
  test('reads the prompts of the directory as sessionDirectory, so a space folder stays on the host', async () => {
    respond = () => json({ version: 1, overrides: { 'plan.todo.visible': 'Project: {{todo_text}}' } });

    const prompts = await loadMagicPrompts('/spaces/space-1/repo');

    expect(prompts.render('plan.todo.visible', { todo_text: 'ship it' })).toBe('Project: ship it');
    expect(prompts.render('plan.improve.visible', { plan_title: 'X' })).toContain('X');
    expect(calls).toHaveLength(1);
    expect([...calls[0].url.searchParams.entries()]).toEqual([['sessionDirectory', '/spaces/space-1/repo']]);
    expect(calls[0].headers.has('x-opencode-directory')).toBe(false);
  });

  test('a failed or malformed read rejects instead of giving built-in text', async () => {
    respond = () => json({ error: 'Magic prompts in /work/repo/.openchamber/project.json cannot be read', code: 'project_prompts_invalid' }, 409);
    await expect(loadMagicPrompts('/work/repo')).rejects.toThrow('cannot be read');

    respond = () => json({ version: 1, overrides: { 'plan.todo.visible': 5 } });
    await expect(loadMagicPrompts('/work/repo')).rejects.toThrow();
  });
});
