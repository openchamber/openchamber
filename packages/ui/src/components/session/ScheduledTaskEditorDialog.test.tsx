import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { clickSuggestedTasksControl, installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const previousFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  const location = { directory: '/repo/app', project: { id: 'app', directory: '/repo/app' } };
  if (path === '/api/location') return Response.json(location);
  if (path === '/api/config' || path === '/api/project') return Response.json([]);
  if (path === '/api/event') return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
  if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 0, sessions: [] });
  if (['/api/session', '/api/session/active', '/api/agent', '/api/model', '/api/provider'].includes(path)) {
    return Response.json({ location, data: [], cursor: { previous: null, next: null } });
  }
  if (path === '/api/model/default') return Response.json({ location, data: null });
  if (path === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  return Response.json({});
}, previousFetch);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../web/src/api');
const { useUIStore } = await import('@/stores/useUIStore');
const { OpenCode } = await import('@opencode/client');
const { ScheduledTaskEditorDialog } = await import('./ScheduledTaskEditorDialog');
const apis = createWebAPIs();
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: globalThis.fetch });
let root: Root;
let saved: Partial<ScheduledTask>[];
const task = (patch: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 'daily', name: 'Daily review', enabled: true,
  schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
  execution: { prompt: 'Review the project.', useDefaults: true, notify: 'finish' },
  state: { createdAt: 1, updatedAt: 1 }, ...patch,
});
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  saved = [];
  useUIStore.setState({ isMobile: false });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); useUIStore.setState({ isMobile: false }); });
afterAll(async () => { globalThis.fetch = previousFetch; await dom.restore(); });
const render = (value: ScheduledTask | null) => act(async () => root.render(
  <RuntimeAPIProvider apis={apis}><SyncProvider sdk={sdk} directory=""><ThemeSystemProvider><I18nProvider>
    <ScheduledTaskEditorDialog open task={value} projectId="app" scopes={[{ id: 'app', label: 'App' }]} onOpenChange={() => undefined} onSave={async (next) => { saved.push(next); }} />
  </I18nProvider></ThemeSystemProvider></SyncProvider></RuntimeAPIProvider>,
));
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const choose = async (control: HTMLElement, label: string, pointerType: 'mouse' | 'touch') => {
  await clickSuggestedTasksControl(control, pointerType);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.trim() === label);
  if (!option) throw new Error(`Missing option: ${label}`);
  await clickSuggestedTasksControl(option, pointerType);
};

describe('scheduled session notifications', () => {
  test('starts a new task with finish notifications', async () => {
    // Given a new task draft.
    await render(null);

    // When the notification picker renders, then it starts at the existing finish behavior.
    expect(document.querySelector('[aria-label="Notify me"]')?.textContent).toContain('When the session finishes');
  });

  for (const mobile of [false, true]) {
    test(`saves attention-only notifications on ${mobile ? 'mobile' : 'desktop'}`, async () => {
      // Given a task that creates a session.
      useUIStore.setState({ isMobile: mobile });
      await render(task());
      const picker = document.querySelector<HTMLElement>('[aria-label="Notify me"]');
      if (!picker) throw new Error('Missing notification picker');

      // When the user chooses attention-only and saves.
      await choose(picker, 'Only when it needs me', mobile ? 'touch' : 'mouse');
      await act(async () => button('Save').click());

      // Then the declared execution policy reaches the API payload.
      expect(saved[0]?.execution?.notify).toBe('attention');
    });
  }

  test('hides the policy for existing-session tasks and retains its stored value', async () => {
    // Given a task that sends to an existing session, which owns its own notifications.
    await render(task({ targetSessionId: 'ses_existing', execution: { prompt: 'Review again.', useDefaults: true, notify: 'attention' } }));

    // When the task is saved without a notification override control.
    await act(async () => button('Save').click());

    // Then no override is offered or changed on the hidden field.
    expect(document.querySelector('[aria-label="Notify me"]')).toBeNull();
    expect(saved[0]?.targetSessionId).toBe('ses_existing');
    expect(saved[0]?.execution?.notify).toBe('attention');
  });

  test('retains an attention-only policy when the saved task is reopened', async () => {
    // Given an already saved attention-only task.
    await render(task({ execution: { prompt: 'Review the project.', useDefaults: true, notify: 'attention' } }));

    // When it is saved again.
    await act(async () => button('Save').click());

    // Then hydration has kept the stored policy.
    expect(saved[0]?.execution?.notify).toBe('attention');
  });
});
