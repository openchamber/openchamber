import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import { configuredBot } from '@/lib/bots/bots.fixture';
import { botsConfigSchema, type BotDefinition, type BotsConfig } from '@/lib/bots/config';
import { saveBotsConfig } from '@/lib/botsApi';
import { botSpaceI18n } from '@/lib/i18n/messages/bot-space.i18n';
import { clickSuggestedTasksControl, deferred, installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const server = await serveSuggestedTasks((request) => handle(request));
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { BotExecutionFields } = await import('./BotExecutionFields');
const copy = botSpaceI18n.en;
let root: Root;
let enabled = true;
let failLogins = false;
let emptyLogins = false;
let requests: string[] = [];
let config: BotsConfig = { concurrency: 2, retentionDays: 90, definitions: [] };
let saved = deferred<void>();

function handle(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  requests.push(url.pathname + url.search);
  if (url.pathname.endsWith('/bots/config')) return request.json().then((body) => {
    config = z.object({ config: botsConfigSchema }).parse(body).config;
    return Response.json({ config });
  });
  if (url.pathname.endsWith('/switch')) return Response.json({ enabled, spaces: [] });
  if (url.pathname.endsWith('/places')) return Response.json({ places: [{ id: 'docker', machine: null, available: true, hostIsolation: true }] });
  if (url.pathname.endsWith('/logins')) return failLogins ? Response.json({ code: 'offline' }, { status: 503 })
    : Response.json({ logins: emptyLogins ? [] : [{ provider: 'github-copilot', method: 'device', expires: null, state: 'usable' }] });
  if (url.pathname.endsWith('/custom-providers')) return Response.json({ providers: [{ id: 'local', name: 'Local Gateway', package: '@ai-sdk/openai-compatible', baseURL: 'http://models.example.com/v1', loopback: false, models: ['local'], hasKey: true, supported: true }] });
  return Response.json({});
}

function Harness({ initial }: { readonly initial: BotDefinition }) {
  const [bot, setBot] = React.useState(initial);
  return <><BotExecutionFields bot={bot} directory="/selected/project" onChange={(patch) => setBot((current) => ({ ...current, ...patch }))} />
    <button type="button" data-testid="save" onClick={() => void saveBotsConfig('project', { ...config, definitions: [bot] }).then(() => saved.resolve())}>Save</button></>;
}

beforeEach(() => {
  enabled = true; failLogins = false; emptyLogins = false; requests = []; saved = deferred<void>();
  config = { concurrency: 2, retentionDays: 90, definitions: [] };
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
afterAll(async () => { await server.stop(true); await dom.restore(); });

const until = (ready: () => boolean) => {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(); } });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
};
const render = async (initial: BotDefinition) => {
  await act(async () => root.render(<I18nProvider><Harness initial={initial} /></I18nProvider>));
  if (initial.isolated) await until(() => document.body.textContent?.includes(enabled ? 'Local Gateway' : copy['bots.space.off']) === true);
};
const control = (selector: string) => {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new TypeError(`Missing control: ${selector}`);
  return element;
};
const input = async (label: string, value: string) => {
  const element = document.querySelector(`[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) throw new TypeError(`Missing input: ${label}`);
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const set = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!set) throw new TypeError('Native value setter is unavailable');
  await act(async () => { set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
};
const save = async () => { await act(async () => { control('[data-testid="save"]').click(); await saved.promise; }); };
const envGrant = { kind: 'model', provider: 'openai', upstream: 'https://api.openai.com/v1', secret: { kind: 'env', name: 'INITIAL_KEY' } } as const;

describe('isolated bot fields', () => {
  for (const failure of [false, true]) test(`keeps the saved OpenAI login source visible when its inventory is ${failure ? 'failed' : 'empty'}`, async () => {
    // Given saved ChatGPT access whose host inventory cannot offer it now.
    failLogins = failure;
    emptyLogins = true;
    const space: NonNullable<BotDefinition['space']> = { network: { mode: 'allowlist', domains: [] }, grants: [{ kind: 'login', provider: 'openai' }] };

    // When the fields load and the definition is saved unchanged.
    await render({ ...configuredBot(), isolated: true, space });
    await save();

    // Then the saved source is still named as ChatGPT, with no misleading key-source picker.
    expect(document.body.textContent).toContain('ChatGPT');
    expect(document.querySelector('[role="combobox"][aria-label="Where the openai key comes from"]')).toBeNull();
    expect(config.definitions[0]?.space).toEqual(space);
  });

  test('keeps offered host logins and providers unselected until the user grants access', async () => {
    // Given usable host inventory and a bot with no configured space access.
    const bot = { ...configuredBot(), isolated: true };

    // When the editor loads and the user saves without choosing access.
    await render(bot);
    await save();

    // Then inventory availability has granted nothing implicitly.
    expect(config.definitions[0]?.space).toBeUndefined();
  });

  test('does not query Spaces when isolation is off', async () => {
    // Given an ordinary bot that does not use isolated execution.
    const bot = configuredBot();

    // When its execution fields open.
    await render(bot);

    // Then even the switch route has not been called.
    expect(requests.some((path) => path.startsWith('/api/openchamber/spaces/'))).toBe(false);
  });

  test('persists an explicit open-network choice while retaining the allowlist draft', async () => {
    // Given an isolated bot with selected access and an exact domain list.
    const space: NonNullable<BotDefinition['space']> = { network: { mode: 'allowlist', domains: ['registry.npmjs.org'] }, grants: [envGrant] };
    await render({ ...configuredBot(), isolated: true, space });

    // When the user chooses the open internet and saves.
    const open = [...document.querySelectorAll('button')].find((element) => element.textContent === 'Open internet');
    if (!open) throw new TypeError('Network choice is unavailable');
    await clickSuggestedTasksControl(open, 'touch');
    await save();

    // Then the selected mode persists and the domain field stays reserved but disabled.
    expect(config.definitions[0]?.space?.network).toEqual({ mode: 'open', domains: ['registry.npmjs.org'] });
    expect(control(`[aria-label="${copy['bots.space.domains']}"]`).hasAttribute('disabled')).toBe(true);
  });

  test('round-trips edited network and selected provider references through the form and HTTP boundary', async () => {
    // Given a saved environment reference, with no implicit login or custom grants.
    await render({ ...configuredBot(), isolated: true, space: { network: { mode: 'allowlist', domains: [] }, grants: [envGrant] } });

    // When the user edits its references and explicitly selects two more providers.
    await input(copy['bots.space.domains'], 'registry.npmjs.org\npackages.example.com');
    await input('Environment variable with the openai key', 'BOT_OPENAI_KEY');
    await input(copy['bots.space.upstream'], 'https://gateway.example.com/v1');
    await clickSuggestedTasksControl(control('[role="checkbox"][aria-label="GitHub Copilot"]'), 'touch');
    await clickSuggestedTasksControl(control('[role="checkbox"][aria-label="Local Gateway"]'), 'touch');
    await save();

    // Then only those explicit references cross the actual config request.
    expect(config.definitions[0]?.space).toEqual({ network: { mode: 'allowlist', domains: ['registry.npmjs.org', 'packages.example.com'] }, grants: [
      { kind: 'model', provider: 'openai', upstream: 'https://gateway.example.com/v1', secret: { kind: 'env', name: 'BOT_OPENAI_KEY' } },
      { kind: 'login', provider: 'github-copilot' }, { kind: 'custom', provider: 'local' },
    ] });
    expect(requests).toContain('/api/openchamber/spaces/custom-providers?directory=%2Fselected%2Fproject');
  });

  test('keeps isolation options when the user hides them before saving', async () => {
    // Given explicit space configuration on an isolated bot.
    const space: NonNullable<BotDefinition['space']> = { network: { mode: 'allowlist', domains: ['registry.npmjs.org'] }, grants: [envGrant] };
    await render({ ...configuredBot(), isolated: true, space: structuredClone(space) });

    // When isolation is turned off and the definition is saved.
    const isolation = [...document.querySelectorAll('[role="button"]')].find((element) => element.textContent === 'Run in an isolated space');
    if (!(isolation instanceof HTMLElement)) throw new TypeError('Isolation toggle is unavailable');
    await clickSuggestedTasksControl(isolation);
    await save();

    // Then the fields are hidden but every reference remains in the saved definition.
    expect(document.querySelector(`[aria-label="${copy['bots.space.domains']}"]`)).toBeNull();
    expect(config.definitions[0]?.space).toEqual(space);
  });

  test('shows the global off reason without querying inventories when Spaces is disabled', async () => {
    // Given the host's authoritative switch is off.
    enabled = false;

    // When an isolated bot's execution fields open.
    await render({ ...configuredBot(), isolated: true });

    // Then the reason is visible and no place, login or provider inventory was probed.
    expect(document.body.textContent).toContain(copy['bots.space.off']);
    expect(requests.filter((path) => path.startsWith('/api/openchamber/spaces/'))).toEqual(['/api/openchamber/spaces/switch']);
  });

  test('preserves saved references and usable catalogs when one inventory request fails', async () => {
    // Given a login read failure and an existing selected login.
    failLogins = true;
    const space: NonNullable<BotDefinition['space']> = { network: { mode: 'allowlist', domains: [] }, grants: [{ kind: 'login', provider: 'github-copilot' }] };

    // When the editor loads the other inventories and saves unchanged.
    await render({ ...configuredBot(), isolated: true, space: structuredClone(space) });
    await save();

    // Then the read failure is explicit, custom choices still show, and the login is not erased.
    expect(document.body.textContent).toContain(copy['bots.space.inventoryFailed']);
    expect(document.body.textContent).toContain('Local Gateway');
    expect(config.definitions[0]?.space).toEqual(space);
  });

  test('keeps environment identifiers left to right under an RTL ancestor', async () => {
    // Given an explicit environment reference inside a right-to-left layout.
    const initial = { ...configuredBot(), isolated: true, space: { network: { mode: 'allowlist', domains: [] }, grants: [envGrant] } } satisfies BotDefinition;

    // When the real execution fields load beneath that ancestor.
    await act(async () => root.render(<I18nProvider><div dir="rtl"><Harness initial={initial} /></div></I18nProvider>));
    await until(() => document.body.textContent?.includes('Local Gateway') === true);

    // Then the host variable's editing direction is explicitly LTR, not inherited.
    expect(control('input[aria-label="Environment variable with the openai key"]').getAttribute('dir')).toBe('ltr');
  });

  test('offers no typed-key input when selecting a model access source', async () => {
    // Given an environment-backed model grant.
    await render({ ...configuredBot(), isolated: true, space: { network: { mode: 'allowlist', domains: [] }, grants: [envGrant] } });

    // When the actual shared source picker opens.
    await clickSuggestedTasksControl(control('[role="combobox"][aria-label="Where the openai key comes from"]'));

    // Then the bot editor cannot offer or mount a raw-secret field.
    expect(document.querySelector('[role="option"][data-value="typed"]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelectorAll('[role="option"]').length).toBe(1);
  });
});
