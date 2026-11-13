import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DesktopSettings } from '@/lib/desktop';
import { createProjectIdFromPath } from '@/lib/projectId';
import { installSuggestedTasksDom, serveSuggestedTasks, settings } from '@/lib/test-utils/suggestedTasks.fixture';
import type { MobileAppActions } from '@/apps/mobileAppContext';

// Base UI captures browser availability on import, so install the DOM before loading the real controls.
const dom = installSuggestedTasksDom();
const project = { id: createProjectIdFromPath('/repo/app'), path: '/repo/app', label: 'Storefront' };
const projectRoute = `/api/projects/${project.id}`;
// The stores sync projects from the settings document in the background. Each
// test applies the same document first, so a late sync changes nothing.
const settingsDocument: DesktopSettings = { projects: [project], activeProjectId: project.id };
const emptyOpenCodeResponse = (request: Request) => {
  const path = new URL(request.url).pathname;
  const location = { directory: project.path, project: { id: project.id, directory: project.path } };
  if (path === '/api/location') return Response.json(location);
  if (path === '/api/config' || path === '/api/project') return Response.json([]);
  if (path === '/api/event') return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
  if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 0, sessions: [] });
  return Response.json({ location, data: [], cursor: { previous: null, next: null } });
};
const bootstrapServer = await serveSuggestedTasks(emptyOpenCodeResponse, settingsDocument);
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { SyncProvider } = await import('@/sync/sync-context');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../web/src/api');
const { getRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { OpenCode } = await import('@opencode/client');
const { ScheduledTasksView } = await import('./ScheduledTasksDialog');
const { DedicatedMobileAppProvider } = await import('@/apps/mobileAppContext');
const { useUIStore } = await import('@/stores/useUIStore');

// The page mounts the scheduled task editor, which reads live sessions.
const apis = createWebAPIs({ urls: getRuntimeUrlResolver() });
const sdk = OpenCode.make({
  baseUrl: 'http://localhost',
  fetch: async (input) => emptyOpenCodeResponse(new Request(input)),
});

const scanTask = {
  id: 'suggested-tasks-scan',
  name: 'Suggested tasks scan',
  enabled: true,
  suggestedScan: true,
  schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
  execution: { prompt: 'This scheduled run belongs to Suggested tasks.', useDefaults: true },
  state: { createdAt: 1, updatedAt: 1, lastSessionId: 'ses_lens', lastRunAt: 1, lastStatus: 'success' },
};
const plainTask = {
  id: 'digest',
  name: 'Daily digest',
  enabled: true,
  schedule: { kind: 'daily', times: ['08:00'], timezone: 'UTC' },
  execution: { prompt: 'Summarize yesterday.', useDefaults: true },
  state: { createdAt: 1, updatedAt: 1, lastSessionId: 'ses_digest', lastRunAt: 1, lastStatus: 'success' },
};
const botTask = { ...plainTask, id: 'bot-scheduler-row', name: 'Parser maintenance', botManaged: true, botId: 'bot-parser' };

let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let root: Root;
const requests: string[] = [];
const initialProjects = useProjectsStore.getState();
let mobileBotOpens = 0;
const mobileActions: MobileAppActions = {
  openBots: () => { mobileBotOpens += 1; }, openChanges: () => {}, openFiles: () => {},
  openSourceBoard: () => {}, openSettingsPage: () => {}, openUpdate: () => {}, openScheduledTasks: () => {},
};

beforeEach(async () => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  requests.length = 0;
  mobileBotOpens = 0;
  useUIStore.getState().closeMainSurfaces();
  useUIStore.getState().setScheduledTasksDialogOpen(true);
  useProjectsStore.getState().synchronizeFromSettings(settingsDocument, { adoptActiveProject: true });
  server = await serveSuggestedTasks((request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith('/scheduled-tasks') && request.method === 'GET') return Response.json({ tasks: [plainTask, scanTask, botTask] });
    if (path.endsWith('/scheduled-tasks/suggested-tasks-scan/run')) return Response.json({ ok: true, sessionId: 'ses_lens', directory: project.path });
    if (path.endsWith('/scheduled-tasks/bot-scheduler-row/run')) return Response.json({ ok: true, sessionId: 'ses_bot', directory: project.path });
    if (path.endsWith('/suggested-tasks/settings')) return Response.json(settings());
    if (path === '/api/git/projects') return Response.json({ projects: [{ directory: project.path, isGitRepository: true }] });
    return emptyOpenCodeResponse(request);
  }, settingsDocument);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server.stop(true);
  useProjectsStore.setState({ projects: initialProjects.projects, activeProjectId: initialProjects.activeProjectId });
  useUIStore.getState().closeMainSurfaces();
  document.body.replaceChildren();
});
afterAll(async () => { await bootstrapServer.stop(true); await dom.restore(); });

const card = (title: string) => {
  const heading = [...document.querySelectorAll('.typography-ui-header')].find((entry) => entry.textContent?.trim() === title);
  const found = heading?.closest('.rounded-lg');
  if (!found) throw new Error(`Missing task: ${title}`);
  return found;
};
const buttonsOf = (scope: ParentNode) => [...scope.querySelectorAll('button')].map((entry) => entry.textContent?.trim() || entry.getAttribute('aria-label'));
const button = (scope: ParentNode, label: string) => {
  const found = [...scope.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const renderPage = async (onLeave: (reason: string) => void = () => undefined, layout: 'page' | 'mobile' = 'page') => {
  const content = <ScheduledTasksView layout={layout} onLeave={onLeave} />;
  await act(async () => root.render(
    <RuntimeAPIProvider apis={apis}><SyncProvider sdk={sdk} directory="">
      <ThemeSystemProvider><I18nProvider>{layout === 'mobile' ? <DedicatedMobileAppProvider actions={mobileActions}>{content}</DedicatedMobileAppProvider> : content}</I18nProvider></ThemeSystemProvider>
    </SyncProvider></RuntimeAPIProvider>,
  ));
  for (let attempt = 0; attempt < 50 && !document.body.textContent?.includes('Daily digest'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
};

describe('Scheduled tasks page: the Suggested tasks scan', () => {
  test('keeps only Run now and Edit on the scan, and every action on other tasks', async () => {
    // Given a project with a scan and an ordinary task, both with a last run.
    await renderPage();

    // Then the scan offers no pause, delete or open session, and the other task keeps them.
    const scan = card('Suggested tasks scan');
    expect(buttonsOf(scan)).toEqual(['Run now', 'Edit']);
    expect(scan.querySelector('[role="checkbox"], input[type="checkbox"]')).toBeNull();
    const digest = card('Daily digest');
    expect(buttonsOf(digest)).toEqual(['Open session', 'Run now', 'Edit', 'Delete Daily digest']);
    expect(digest.querySelector('[aria-label="Pause Daily digest"]')).not.toBeNull();
  });

  test('opens Configure from Edit on the scan, titled with the project', async () => {
    // Given the scan's row.
    await renderPage();

    // When Edit is pressed.
    await act(async () => button(card('Suggested tasks scan'), 'Edit').click());
    for (let attempt = 0; attempt < 50 && !document.querySelector('[role="dialog"]')?.textContent?.includes('Scan this project'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }

    // Then the Suggested tasks settings open over the page, without the scheduled task editor.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('Storefront');
    expect(dialog?.textContent).toContain('Scan this project for suggested tasks');
    expect(requests).toContain(`GET ${projectRoute}/suggested-tasks/settings`);
  });

  test('runs the scan without leaving the page for one of its lens sessions', async () => {
    // Given the scan's row.
    const left: string[] = [];
    await renderPage((reason) => left.push(reason));

    // When Run now is pressed.
    await act(async () => button(card('Suggested tasks scan'), 'Run now').click());
    for (let attempt = 0; attempt < 50 && !requests.includes(`POST ${projectRoute}/scheduled-tasks/suggested-tasks-scan/run`); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    // Then the scan starts and the page stays open.
    expect(requests).toContain(`POST ${projectRoute}/scheduled-tasks/suggested-tasks-scan/run`);
    expect(left).toEqual([]);
  });
});

describe('bot-managed scheduled tasks', () => {
  for (const layout of ['page', 'mobile'] as const) {
    test(`opens the exact bot definition from ${layout} without admitting a scheduled-task edit`, async () => {
      // Given the server names a bot-owned row with a last session.
      const left: string[] = [];
      await renderPage((reason) => left.push(reason), layout);
      const managed = card(botTask.name);
      expect(buttonsOf(managed)).toEqual(['Run now', 'Edit']);
      expect(managed.querySelector('[role="checkbox"], input[type="checkbox"]')).toBeNull();
      expect(managed.textContent).toContain('Managed by bot');

      // When Edit is pressed.
      await act(async () => button(managed, 'Edit').click());

      // Then the shell opens that definition and never opens the task editor or a session.
      expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: project.id, botId: botTask.botId });
      expect(useUIStore.getState().isBotsPageOpen).toBe(layout === 'page');
      expect(mobileBotOpens).toBe(layout === 'mobile' ? 1 : 0);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(requests.some((request) => request.startsWith('PUT ') || request.startsWith('DELETE '))).toBe(false);
      expect(left).toEqual([]);
    });

    test(`keeps Run now on ${layout} without navigating its bot session`, async () => {
      // Given a bot row whose run endpoint returns a stage session.
      const left: string[] = [];
      await renderPage((reason) => left.push(reason), layout);
      const run = button(card(botTask.name), 'Run now');

      // When the scheduled bot runs and the action settles.
      await act(async () => run.click());
      await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => { if (!run.disabled) { clearTimeout(deadline); observer.disconnect(); resolve(); } });
        const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Run now did not settle')); }, 3000);
        observer.observe(run, { attributes: true });
        if (!run.disabled) { clearTimeout(deadline); observer.disconnect(); resolve(); }
      });

      // Then the real scheduler route was used and stage-session navigation stays with Bots.
      expect(requests).toContain(`POST ${projectRoute}/scheduled-tasks/${botTask.id}/run`);
      expect(left).toEqual([]);
      expect(useUIStore.getState().isBotsPageOpen).toBe(false);
      expect(mobileBotOpens).toBe(0);
    });
  }
});
