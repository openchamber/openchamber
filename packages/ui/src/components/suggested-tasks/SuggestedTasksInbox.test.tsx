import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { z } from 'zod';
import { deferred, inbox, installSuggestedTasksDom, serveSuggestedTasks, settings, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';

// Base UI captures browser availability on import, so install the DOM before loading the real controls.
const dom = installSuggestedTasksDom();
const bootstrapServer = await serveSuggestedTasks(() => Response.json({}));
const { checkIsGitRepository } = await import('@/lib/gitApi');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { useSuggestedTasksSettingsStore } = await import('@/stores/useSuggestedTasksSettingsStore');
const { useSuggestedTasksStore } = await import('@/stores/useSuggestedTasksStore');
const { SuggestedTasksInbox } = await import('./SuggestedTasksInbox');
const { SuggestedLensEditorDialog } = await import('./SuggestedLensEditorDialog');
const { SuggestedTasksSettingsForm } = await import('./SuggestedTasksSettingsForm');
let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let root: Root;
let isGit = false;
let enabled = true;
const project = { id: 'app', path: '/notes' };
const directoriesSchema = z.object({ directories: z.array(z.string()) });
beforeEach(async () => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  isGit = false;
  enabled = true;
  server = await serveSuggestedTasks(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/git/projects') {
      const { directories } = directoriesSchema.parse(await request.json());
      return Response.json({ projects: directories.map((directory) => ({ directory, isGitRepository: isGit })) });
    }
    if (path.endsWith('/settings')) return Response.json({ ...settings(), config: { ...settings().config, enabled } });
    return Response.json(inbox([suggestion()]));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server.stop(true);
  document.body.replaceChildren();
});
afterAll(async () => { await bootstrapServer.stop(true); await dom.restore(); });

const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
// The form's on/off switch, read through its pressed state.
const scanSwitch = (scope: ParentNode) => [...scope.querySelectorAll('[role="button"]')]
  .find((entry) => entry.textContent?.trim() === 'Scan this project for suggested tasks');
const renderInbox = async () => {
  await Promise.all([useSuggestedTasksStore.getState().loadInbox(project.id), useSuggestedTasksSettingsStore.getState().load(project.id)]);
  await act(async () => root.render(<ThemeSystemProvider><I18nProvider><SuggestedTasksInbox project={project} onLeave={() => undefined} /></I18nProvider></ThemeSystemProvider>));
  await act(async () => { await checkIsGitRepository(project.path); });
};
const approvalActions = async () => {
  await act(async () => button('Approve as').click());
  return [...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim());
};

describe('Suggested tasks Git availability', () => {
  test('omits worktree and draft-PR actions when the project is not Git', async () => {
    // Given a project the existing Git API confirms is not a repository.
    await renderInbox();

    // When its approval menu opens.
    const actions = await approvalActions();

    // Then ordinary actions remain available and Git-only actions do not.
    expect(actions).toContain('Start session');
    expect(actions).not.toContain('Session in a new worktree');
    expect(actions).not.toContain('Work until a draft pull request');
  });

  test('offers worktree and draft-PR actions after Git is confirmed', async () => {
    // Given a repository confirmed through the same runtime Git check.
    isGit = true;
    await renderInbox();

    // When its approval menu opens.
    const actions = await approvalActions();

    // Then both Git-only conversion choices are reachable.
    expect(actions).toContain('Session in a new worktree');
    expect(actions).toContain('Work until a draft pull request');
  });

  test('disables scans when the server says the feature is off and sets the project up from Configure', async () => {
    // Given authoritative disabled settings.
    enabled = false;
    await renderInbox();
    expect(button('Scan now').disabled).toBe(true);

    // When Configure is pressed.
    await act(async () => button('Configure').click());
    await act(async () => { await useSuggestedTasksSettingsStore.getState().load(project.id); });

    // Then the project's settings open over the inbox, titled with the project.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('notes');
    expect(dialog ? scanSwitch(dialog)?.getAttribute('aria-pressed') : null).toBe('false');
  });

  test('prevents selecting Git-only automatic actions in a non-Git lens editor', async () => {
    // Given a valid read-only lens in a non-Git project.
    const lens = settings().config.lenses[0];
    if (!lens) throw new Error('Missing fixture lens');

    // When its editor opens without a confirmed repository.
    await act(async () => root.render(<I18nProvider><SuggestedLensEditorDialog lens={lens} projectId={project.id} directory={project.path} canCreateWorktree={false} isNew={false}
      onOpenChange={() => undefined} onSave={async () => true} onDelete={async () => true} /></I18nProvider>));

    // Then both Git-only options are disabled, while a session action remains selectable.
    const options = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="button"]')];
    const option = (label: string) => {
      const found = options.find((entry) => entry.textContent?.startsWith(label));
      if (!found) throw new Error(`Missing action: ${label}`);
      return found;
    };
    expect(option('Start a session in a new worktree').getAttribute('aria-disabled')).toBe('true');
    expect(option('Work until a draft pull request').getAttribute('aria-disabled')).toBe('true');
    expect(option('Start a session').getAttribute('aria-disabled')).not.toBe('true');
  });

  test('keeps the selected project settings when an earlier project read returns', async () => {
    // Given a settings read for project A that has not answered yet.
    await server.stop(true);
    const started = deferred<void>();
    const response = deferred<Response>();
    server = await serveSuggestedTasks(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/git/projects') {
        const { directories } = directoriesSchema.parse(await request.json());
        return Response.json({ projects: directories.map((directory) => ({ directory, isGitRepository: false })) });
      }
      if (path.includes('/projects/a/')) { started.resolve(); return response.promise; }
      return Response.json({ ...settings(), config: { ...settings().config, enabled: false } });
    });
    await act(async () => root.render(<I18nProvider><SuggestedTasksSettingsForm projectRef={{ id: 'a', path: '/repo/a' }} /></I18nProvider>));
    await started.promise;

    // When project B opens and the older A read completes afterwards.
    await act(async () => root.render(<I18nProvider><SuggestedTasksSettingsForm projectRef={{ id: 'b', path: '/repo/b' }} /></I18nProvider>));
    await act(async () => { await useSuggestedTasksSettingsStore.getState().load('b'); });
    const published = deferred<void>();
    const release = useSuggestedTasksSettingsStore.subscribe((state) => { if (state.entries.a?.settings) published.resolve(); });
    await act(async () => {
      response.resolve(Response.json(settings()));
      await published.promise;
    });
    release();

    // Then the selected project's disabled setting stays on screen.
    expect(scanSwitch(document)?.getAttribute('aria-pressed')).toBe('false');
  });
});
