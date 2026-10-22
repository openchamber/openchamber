import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DesktopSettings } from '@/lib/desktop';
import { createProjectIdFromPath } from '@/lib/projectId';
import { installSuggestedTasksDom, serveSuggestedTasks, settings } from '@/lib/test-utils/suggestedTasks.fixture';

// Base UI captures browser availability on import, so install the DOM before loading the real controls.
const dom = installSuggestedTasksDom();
const project = { id: createProjectIdFromPath('/repo/app'), path: '/repo/app', label: 'Storefront' };
const projectRoute = `/api/projects/${project.id}`;
// The stores sync projects from the settings document in the background. Each
// test applies the same document first, so a late sync changes nothing.
const settingsDocument: DesktopSettings = { projects: [project], activeProjectId: project.id };
const bootstrapServer = await serveSuggestedTasks(() => Response.json({}), settingsDocument);
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { SyncProvider } = await import('@/sync/sync-context');
const { OpenCode } = await import('@opencode/client');
const { ScheduledTasksView } = await import('./ScheduledTasksDialog');

// The page mounts the scheduled task editor, which reads live sessions.
const sdk = OpenCode.make({
  baseUrl: 'http://localhost',
  fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
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

let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let root: Root;
const requests: string[] = [];
const initialProjects = useProjectsStore.getState();

beforeEach(async () => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  requests.length = 0;
  useProjectsStore.getState().synchronizeFromSettings(settingsDocument, { adoptActiveProject: true });
  server = await serveSuggestedTasks((request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith('/scheduled-tasks') && request.method === 'GET') return Response.json({ tasks: [plainTask, scanTask] });
    if (path.endsWith('/scheduled-tasks/suggested-tasks-scan/run')) return Response.json({ ok: true, sessionId: 'ses_lens', directory: project.path });
    if (path.endsWith('/suggested-tasks/settings')) return Response.json(settings());
    if (path === '/api/git/projects') return Response.json({ projects: [{ directory: project.path, isGitRepository: true }] });
    return Response.json({});
  }, settingsDocument);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server.stop(true);
  useProjectsStore.setState({ projects: initialProjects.projects, activeProjectId: initialProjects.activeProjectId });
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
const renderPage = async (onLeave: (reason: string) => void = () => undefined) => {
  await act(async () => root.render(
    <SyncProvider sdk={sdk} directory="">
      <ThemeSystemProvider><I18nProvider><ScheduledTasksView layout="page" onLeave={onLeave} /></I18nProvider></ThemeSystemProvider>
    </SyncProvider>,
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
