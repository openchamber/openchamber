import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { z } from 'zod';
import { botsConfig, configuredBot } from '@/lib/bots/bots.fixture';
import { clickSuggestedTasksControl, deferred, inbox, installSuggestedTasksDom, serveSuggestedTasks, settings, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';
import type { Suggestion } from '@/lib/suggestedTasksApi';
import type { MobileAppActions } from '@/apps/mobileAppContext';

const dom = installSuggestedTasksDom();
const bootstrap = await serveSuggestedTasks(() => Response.json({}));
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { DedicatedMobileAppProvider } = await import('@/apps/mobileAppContext');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSuggestedTasksStore } = await import('@/stores/useSuggestedTasksStore');
const { useSuggestedTasksSettingsStore } = await import('@/stores/useSuggestedTasksSettingsStore');
const { SuggestedTasksInbox } = await import('./SuggestedTasksInbox');
const project = { id: 'handoff-project', path: '/repo' };
const evidence = [{ source: 'APP-42', summary: 'Reproduction attached.', url: 'https://jira.example/APP-42' }];
const requestSchema = z.object({ action: z.literal('bot'), botId: z.string() });
let record: Suggestion;
let root: Root;
let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let botReads = 0;
let mobileOpens = 0;
let botResponse: () => Response;
let approval: () => Response | Promise<Response>;
const requests: { path: string; body: z.infer<typeof requestSchema> }[] = [];
const leaves: string[] = [];
const mobileActions: MobileAppActions = {
  openBots: () => { mobileOpens += 1; }, openChanges: () => {}, openFiles: () => {},
  openSourceBoard: () => {}, openSettingsPage: () => {}, openUpdate: () => {}, openScheduledTasks: () => {},
};
const confirm = () => Response.json({ suggestion: { ...record, status: 'approved', conversion: { kind: 'bot', botId: 'bot-2', itemId: 'item-7' } } });
beforeEach(async () => {
  record = suggestion({ evidence, files: [{ path: 'src/parser.ts', startLine: 8 }] });
  botReads = 0; mobileOpens = 0; requests.length = 0; leaves.length = 0;
  botResponse = () => Response.json({ config: { ...botsConfig(), definitions: [
    configuredBot(), { ...configuredBot(), id: 'bot-2', name: 'Second bot' }, { ...configuredBot(), id: 'disabled', name: 'Disabled bot', enabled: false },
  ] }, revision: 1, items: [], presets: [] });
  approval = confirm;
  useUIStore.getState().closeMainSurfaces();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  server = await serveSuggestedTasks(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/bots')) { botReads += 1; return botResponse(); }
    if (path.endsWith('/approve')) { requests.push({ path, body: requestSchema.parse(await request.json()) }); return approval(); }
    if (path.endsWith('/settings')) return Response.json(settings());
    if (path === '/api/git/projects') return Response.json({ projects: [{ directory: project.path, isGitRepository: false }] });
    return Response.json(inbox([record]));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server.stop(true);
  useUIStore.getState().closeMainSurfaces();
  Reflect.deleteProperty(window, '__VSCODE_CONFIG__');
  document.body.replaceChildren();
});
afterAll(async () => { await bootstrap.stop(true); await dom.restore(); });

const button = (label: string) => {
  const scope = document.querySelector('[role="dialog"]') ?? document;
  const found = [...scope.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const waitFor = (ready: () => boolean) => new Promise<void>((resolve, reject) => {
  const observer = new MutationObserver(check);
  const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Expected rendered handoff state')); }, 3000);
  function check() { if (ready()) { clearTimeout(deadline); observer.disconnect(); resolve(); } }
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  check();
});
const render = async (mobile = false) => {
  await useSuggestedTasksStore.getState().loadInbox(project.id);
  await useSuggestedTasksSettingsStore.getState().load(project.id);
  if (!mobile) useUIStore.getState().setSuggestedTasksPageOpen(true);
  const content = <SuggestedTasksInbox project={project} onLeave={(reason) => leaves.push(reason)} />;
  await act(async () => root.render(<ThemeSystemProvider><I18nProvider>
    {mobile ? <DedicatedMobileAppProvider actions={mobileActions}>{content}</DedicatedMobileAppProvider> : content}
  </I18nProvider></ThemeSystemProvider>));
};
const openHandoff = async (mobile = false) => {
  await act(async () => button('Approve as').click());
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === 'Send to bot');
  if (!action) throw new Error('Missing handoff menu action');
  await clickSuggestedTasksControl(action, mobile ? 'touch' : 'mouse');
  await waitFor(() => document.querySelector('button[role="combobox"]')?.getAttribute('disabled') === null);
};
const chooseBot = async (mobile = false) => {
  const picker = document.querySelector<HTMLElement>('button[role="combobox"]');
  if (!picker) throw new Error('Missing bot picker');
  await clickSuggestedTasksControl(picker, mobile ? 'touch' : 'mouse');
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((entry) => entry.textContent?.trim())).toEqual(['Repository bot', 'Second bot']);
  const second = options.find((entry) => entry.textContent?.trim() === 'Second bot');
  if (!second) throw new Error('Missing enabled bot');
  await clickSuggestedTasksControl(second, mobile ? 'touch' : 'mouse');
};
const cached = () => {
  const entry = useSuggestedTasksStore.getState().inboxes[project.id];
  return entry && entry.status !== 'loading' ? entry.inbox?.suggestions[0] : undefined;
};

describe('suggestion bot handoff component and HTTP contract', () => {
  for (const mobile of [false, true]) {
    test(`hands off evidence and navigates the server item on ${mobile ? 'mobile' : 'desktop'}`, async () => {
      // Given a rendered inbox that has made no per-card bot reads.
      await render(mobile);
      expect(botReads).toBe(0);
      await openHandoff(mobile);
      await chooseBot(mobile);

      // When the user explicitly submits the selected enabled bot.
      await act(async () => button('Send to bot').click());
      await waitFor(() => !document.querySelector('[role="dialog"]'));

      // Then the source approval owns conversion, keeps evidence, and opens the correct item in this shell.
      expect(requests).toEqual([{ path: `/api/projects/${project.id}/suggested-tasks/items/suggestion-1/approve`, body: { action: 'bot', botId: 'bot-2' } }]);
      expect(botReads).toBe(1);
      expect(cached()).toMatchObject({ status: 'approved', evidence, files: record.files, conversion: { botId: 'bot-2', itemId: 'item-7' } });
      expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: project.id, itemId: 'item-7' });
      expect(useUIStore.getState().isBotsPageOpen).toBe(!mobile);
      expect(mobileOpens).toBe(mobile ? 1 : 0);
      expect(leaves).toEqual([]);
    });

    test(`opens a persisted bot conversion from the approved card on ${mobile ? 'mobile' : 'desktop'}`, async () => {
      // Given the server returns a persisted conversion using kind, botId and itemId.
      server = await replaceServerWithApproved();
      await render(mobile);
      await act(async () => button('Approved 1').click());

      // When the card's item link is pressed.
      await act(async () => button('Open bot item').click());

      // Then it reaches that item without fetching every card's bot definitions.
      expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: project.id, itemId: 'item-7' });
      expect(mobileOpens).toBe(mobile ? 1 : 0);
      expect(botReads).toBe(0);
    });
  }

  test('retains the source and the same bot after an unknown answer and permits an idempotent retry', async () => {
    // Given a submission whose response is still in flight.
    const response = deferred<Response>();
    const started = deferred<void>();
    approval = () => { started.resolve(); return response.promise; };
    await render(); await openHandoff(); await chooseBot();
    await act(async () => { button('Send to bot').click(); await started.promise; });
    expect(document.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    expect(requests).toHaveLength(1);

    // When an unconfirmed answer is followed by a retry of that same source and bot.
    await act(async () => response.resolve(Response.json({ unknown: true })));
    await waitFor(() => !button('Send to bot').disabled);
    expect(cached()).toEqual(record);
    expect(document.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Retry with the same bot');
    approval = confirm;
    await act(async () => button('Send to bot').click());
    await waitFor(() => !document.querySelector('[role="dialog"]'));

    // Then both attempts have the same identity and only a confirmed response replaces the source.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(cached()?.status).toBe('approved');
  });

  test('reports a failed bot read without offering an empty successful picker', async () => {
    // Given the bot configuration endpoint is unavailable.
    botResponse = () => Response.json({ error: 'Unavailable' }, { status: 503 });
    await render();

    // When the handoff opens.
    await act(async () => button('Approve as').click());
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === 'Send to bot');
    if (!action) throw new Error('Missing handoff action');
    await clickSuggestedTasksControl(action);
    await waitFor(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.includes('Could not load bots') === true);

    // Then the error has a retry, no mutation is sent, and the suggestion stays intact.
    expect(button('Try again').disabled).toBe(false);
    expect(requests).toEqual([]);
    expect(cached()).toEqual(record);
  });

  test('omits the bot action in VS Code', async () => {
    // Given an extension-host runtime.
    Object.defineProperty(window, '__VSCODE_CONFIG__', { value: { workspaceFolder: project.path }, configurable: true });
    await render();

    // When approval choices open.
    await act(async () => button('Approve as').click());

    // Then bots are absent and their API has not been read.
    expect([...document.querySelectorAll('[role="menuitem"]')].some((entry) => entry.textContent?.includes('Send to bot'))).toBe(false);
    expect(botReads).toBe(0);
  });
});

async function replaceServerWithApproved() {
  await server.stop(true);
  return serveSuggestedTasks((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/settings')) return Response.json(settings());
    if (path === '/api/git/projects') return Response.json({ projects: [{ directory: project.path, isGitRepository: false }] });
    return Response.json({ ...inbox(), suggestions: [{ ...record, status: 'approved', conversion: { kind: 'bot', botId: 'bot-2', itemId: 'item-7' } }] });
  });
}
