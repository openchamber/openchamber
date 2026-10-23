import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import { fetchBotIdentities } from '@/lib/botsApi';
import type { BotIdentity } from '@/lib/bots/management';
import { botsI18n } from '@/lib/i18n/messages/bots.i18n';
import { clickSuggestedTasksControl, deferred, installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const identity = {
  id: 'oauth-identity', revision: 7, kind: 'jira-oauth', configured: true, label: 'Jira triage OAuth',
  site: 'https://triage.atlassian.net', cloudId: '0316c4f6-7a2b-4893-86b8-d9ef92442567', clientId: 'jira-client-42',
} as const;
const responseSecrets = { clientSecret: 'response-must-not-hydrate', token: 'response-token', accessToken: 'response-access-token', apiToken: 'response-api-token' };
let root: Root;
let saved = deferred<void>();
let writes: { readonly path: string; readonly method: string; readonly body: z.infer<typeof json> }[] = [];
let failWrite = false;
const json = z.json();
const server = await serveSuggestedTasks(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' || request.method === 'PUT') {
      writes.push({ path, method: request.method, body: json.parse(await request.json()) });
      return failWrite ? Response.json({ code: 'identity_invalid', error: responseSecrets.clientSecret }, { status: 400 })
        : Response.json({ identity: { ...identity, ...responseSecrets } });
    }
    if (path.endsWith('/identities')) return Response.json({ identities: [
      { ...identity, ...responseSecrets },
      { id: 'legacy-jira', revision: 1, kind: 'jira-service', configured: true, label: 'Legacy Jira' },
      { id: 'discord', revision: 1, kind: 'discord-app', configured: true, label: 'Discord only' },
    ] });
    return Response.json({ authenticated: false, accounts: [] });
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const { BotIdentityEditor } = await import('./BotIdentityEditor');
const { BotIdentities } = await import('./BotIdentities');
const { BotIdentityFields } = await import('./BotIdentityFields');
const apis = createWebAPIs();

beforeEach(() => {
  saved = deferred<void>(); writes = []; failWrite = false;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
afterAll(async () => { await server.stop(true); await dom.restore(); });

const render = async (view: React.ReactNode) => {
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>{view}</I18nProvider></RuntimeAPIContext.Provider>));
};
const control = (selector: string) => {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new TypeError(`Missing control: ${selector}`);
  return element;
};
const field = (label: string) => {
  const element = control(`input[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement)) throw new TypeError(`Missing input: ${label}`);
  return element;
};
const input = async (label: string, value: string) => {
  const element = field(label);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!set) throw new TypeError('Native value setter is unavailable');
  await act(async () => { set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
};
const option = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === label);
  if (!element) throw new TypeError(`Missing option: ${label}`);
  return element;
};
const select = async (label: string, optionLabel: string) => {
  await clickSuggestedTasksControl(control(`[role="combobox"][aria-label="${label}"]`));
  await clickSuggestedTasksControl(option(optionLabel));
};
const until = (ready: () => boolean) => {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(); } });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  });
};
const editor = (initial: BotIdentity | null = null) => render(<BotIdentityEditor projectId="project-1" initial={initial} onSaved={() => saved.resolve()} onClose={() => {}} />);
const save = () => act(async () => { control('button[type="submit"]').click(); await saved.promise; });

describe('Jira OAuth identity form and HTTP contract', () => {
  test('creates the exact OAuth definition when the user submits the form', async () => {
    // Given a new OAuth identity entered through the actual kind picker and fields.
    await editor();
    await select('Identities', botsI18n.en['bots.jiraOAuth']);
    await input('Name', identity.label);
    await input('Site', identity.site);
    await input('Cloud ID', identity.cloudId);
    await input('Client ID', identity.clientId);
    await input('Client secret', 'fixture-create-secret');

    // When the user saves.
    await save();

    // Then POST contains only the OAuth write contract and the mounted secret is cleared.
    expect(writes).toEqual([{ path: '/api/projects/project-1/bots/identities', method: 'POST', body: {
      kind: 'jira-oauth', label: identity.label, site: identity.site, cloudId: identity.cloudId, clientId: identity.clientId, clientSecret: 'fixture-create-secret',
    } }]);
    expect(field('Client secret').value).toBe('');
    expect(control('button[type="submit"]').hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('input[type="email"]')).toBeNull();
  });

  test('requires a fresh secret when editing public OAuth metadata and sends the revision envelope', async () => {
    // Given an identity loaded through the real response parser, even if the server includes secrets.
    const { identities } = await fetchBotIdentities('project-1');
    const initial = identities[0];
    if (!initial) throw new TypeError('Missing fixture identity');
    expect(initial).toEqual(identity);
    await editor(initial);
    expect(field('Site').value).toBe(identity.site);
    expect(field('Cloud ID').value).toBe(identity.cloudId);
    expect(field('Client ID').value).toBe(identity.clientId);
    expect(field('Client secret').value).toBe('');
    expect(control('button[type="submit"]').hasAttribute('disabled')).toBe(true);
    await input('Client ID', 'replacement-client');
    await input('Cloud ID', '02bfbc28-14eb-44d7-963a-6fe379db779c');
    await input('Client secret', 'fixture-replacement-secret');

    // When the user explicitly saves the replacement.
    await save();

    // Then PUT carries the edited definition and expected revision, with no hydrated secret retained.
    expect(writes).toEqual([{ path: '/api/projects/project-1/bots/identities/oauth-identity', method: 'PUT', body: {
      definition: { kind: 'jira-oauth', label: identity.label, site: identity.site, cloudId: '02bfbc28-14eb-44d7-963a-6fe379db779c', clientId: 'replacement-client', clientSecret: 'fixture-replacement-secret' },
      expectedRevision: 7,
    } }]);
    expect(field('Client secret').value).toBe('');
  });

  test('clears the secret and retains the public draft when a write fails', async () => {
    // Given a replacement form and a server that refuses the write.
    failWrite = true;
    await editor(identity);
    await input('Client secret', 'fixture-failing-secret');

    // When the user saves and the failure reaches the form.
    await act(async () => { control('button[type="submit"]').click(); });
    await until(() => Boolean(document.querySelector('[role="alert"]')?.textContent));

    // Then the secret is gone, metadata remains, and the upstream error body is never displayed.
    expect(field('Client secret').value).toBe('');
    expect(field('Client ID').value).toBe(identity.clientId);
    expect(document.body.textContent).not.toContain(responseSecrets.clientSecret);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('identity_invalid');
  });

  for (const change of [
    { from: botsI18n.en['bots.jiraService'], to: botsI18n.en['bots.jiraOAuth'], previous: 'New secret', next: 'Client secret' },
    { from: botsI18n.en['bots.jiraOAuth'], to: botsI18n.en['bots.jiraService'], previous: 'Client secret', next: 'New secret' },
  ]) test(`clears the secret when switching from ${change.from} to ${change.to}`, async () => {
    // Given a draft with a secret for one Jira authentication kind.
    await editor();
    await select('Identities', change.from);
    await input(change.previous, 'fixture-previous-kind-secret');

    // When the user switches authentication kind.
    await select('Identities', change.to);

    // Then the selected kind never receives the previous kind's secret.
    expect(field(change.next).value).toBe('');
    expect(writes).toEqual([]);
  });

  test('shows only public OAuth metadata when the identities list loads', async () => {
    // Given a successful identity response containing extra secret-bearing fields.
    await render(<BotIdentities projectId="project-1" />);

    // When the list renders the parsed identity.
    await until(() => document.body.textContent?.includes(identity.label) === true);

    // Then its kind and public IDs are visible without any response secret.
    for (const value of [identity.kind, identity.site, identity.cloudId, identity.clientId]) expect(document.body.textContent).toContain(value);
    for (const secret of Object.values(responseSecrets)) expect(document.body.textContent).not.toContain(secret);
  });

  test('selects an OAuth identity for Jira without offering Discord identities', async () => {
    // Given the real Jira picker loaded from the identities endpoint.
    let selected: string | undefined;
    await render(<BotIdentityFields projectId="project-1" value={{}} onChange={(value) => { selected = value.jira?.identityId; }} onManage={() => {}} />);
    await until(() => document.querySelector('[role="status"]') === null);

    // When the user chooses the OAuth identity.
    await clickSuggestedTasksControl(control('[role="combobox"][aria-label="Jira"]'));
    expect(option('Legacy Jira')).toBeDefined();
    expect([...document.querySelectorAll('[role="option"]')].map((entry) => entry.textContent)).not.toContain('Discord only');
    await clickSuggestedTasksControl(option(identity.label));

    // Then the bot identity reference names the selected OAuth identity.
    expect(selected).toBe(identity.id);
  });

  test('keeps OAuth identifiers and the password field LTR beneath an RTL ancestor', async () => {
    // Given the shared editor beneath a right-to-left ancestor.
    await render(<div dir="rtl"><BotIdentityEditor projectId="project-1" initial={identity} onSaved={() => {}} onClose={() => {}} /></div>);

    // When its credential controls render.
    const fields = ['Site', 'Cloud ID', 'Client ID', 'Client secret'].map(field);

    // Then identifiers retain their reading direction and the secret stays a fresh password input.
    expect(fields.map((element) => element.dir)).toEqual(['ltr', 'ltr', 'ltr', 'ltr']);
    expect(field('Client secret').type).toBe('password');
    expect(field('Client secret').value).toBe('');
  });
});

test('ships translated OAuth field labels in every bot locale', () => {
  // Given the shared bot dictionaries and new OAuth controls.
  const keys = ['bots.jiraOAuth', 'bots.cloudId', 'bots.clientId', 'bots.clientSecret'] as const;

  // When each shipped locale is read.
  for (const [locale, copy] of Object.entries(botsI18n)) {
    // Then each control has a real localized label.
    for (const key of keys) {
      expect(copy[key]).toBeTruthy();
      if (locale !== 'en') expect(copy[key]).not.toBe(botsI18n.en[key]);
    }
  }
});
