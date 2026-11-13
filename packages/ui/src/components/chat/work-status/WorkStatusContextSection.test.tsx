import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { toast } from 'sonner';
import type { Session } from '@/lib/opencode/model';
import type { LinkedIssue } from '@/lib/linkedIssues';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import * as sessionActions from '@/sync/session-actions';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Part } from '@/lib/opencode/model';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

let outsideRepository: string | null = null;
mock.module('@/components/sourceBoard/useOutsideRepository', () => ({ useOutsideRepository: () => outsideRepository }));

let WorkStatusContextSection: typeof import('./WorkStatusContextSection').WorkStatusContextSection;

const directory = '/unlink-test';
const sessionId = 'session-unlink';
const githubIssue: LinkedIssue = {
  id: 'acme/app#12', number: 12, title: 'Rail badge count', url: 'https://github.com/acme/app/issues/12',
  kind: 'issue', author: 'someone', linkedAt: 1,
};
const linearIssue: LinkedIssue = {
  id: 'linear:ENG-7', kind: 'tracker', provider: 'linear', identifier: 'ENG-7', title: 'Broken login', url: 'https://linear.app/acme/issue/ENG-7',
  linkedAt: 2,
};
const sessionWith = (linked: LinkedIssue[]): Session => ({
  id: sessionId, projectID: 'project', directory, title: 'Unlink', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { linked_issues: linked } },
});

describe('agent-linked threads in the context section', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  let fetchSpy: ReturnType<typeof spyOn>;
  const sdk = OpenCode.make({ baseUrl: 'http://unlink.test', fetch: () => new Promise<Response>(() => undefined) });
  const render = async (apis: RuntimeAPIs | null = null) => {
    await act(async () => root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <SyncProvider sdk={sdk} directory={directory}>
            <WorkStatusContextSection sessionId={sessionId} directory={directory} />
          </SyncProvider>
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    ));
  };
  const publish = async (linked: LinkedIssue[]) => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState({ session: [sessionWith(linked)] }));
  };
  // The skills list answered for a `/api/config/skills` request URL.
  let skillsFor = (_url: string): Array<{ name: string; path: string; scope: string; source: string }> => [];
  const unlinkButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove link"]'));

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLIFrameElement: win.HTMLIFrameElement,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
      ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    skillsFor = () => [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      if (target.includes('/session-knowledge/summary')) return Response.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
      if (target.includes('/config/skills')) return Response.json({ skills: skillsFor(target) });
      return Response.json({ data: [], cursor: {} });
    });
    ({ WorkStatusContextSection } = await import('./WorkStatusContextSection'));
    useUIStore.setState({ workStatusExpandedSections: { 'context-sources': true } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
    await publish([githubIssue, linearIssue]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('offers a remove control on every linked row that unlinks the thread', async () => {
    expect(container.textContent).toContain('Rail badge count');
    expect(container.textContent).toContain('Broken login');
    const buttons = unlinkButtons();
    expect(buttons.length).toBe(2);

    const unlink = spyOn(sessionActions, 'setLinkedIssue').mockResolvedValue(sessionWith([]));
    await act(async () => { buttons[0].click(); });
    expect(unlink.mock.calls.length).toBe(1);
    expect(unlink.mock.calls[0]?.[0]).toBe(sessionId);
    expect(unlink.mock.calls[0]?.[1]).toBe(directory);
    expect(unlink.mock.calls[0]?.[2]).toMatchObject({ id: 'acme/app#12' });
    expect(unlink.mock.calls[0]?.[3]).toBe(false);
    unlink.mockRestore();
  });

  test('names the repository of a link outside the project after its number', async () => {
    await render();
    outsideRepository = 'dotnet/runtime';
    await publish([githubIssue]);
    expect(container.textContent).toContain('#12 · dotnet/runtime · Rail badge count');
    outsideRepository = null;
  });

  test('reports a failed unlink instead of silently keeping the link', async () => {
    const unlink = spyOn(sessionActions, 'setLinkedIssue').mockRejectedValue(new Error('metadata request failed'));
    const reported = spyOn(toast, 'error');
    await act(async () => { unlinkButtons()[0]?.click(); });
    expect(unlink.mock.calls.length).toBe(1);
    expect(reported.mock.calls.length).toBe(1);
    expect(reported.mock.calls[0]?.[0]).toBe('Could not remove the link');
    reported.mockRestore();
    unlink.mockRestore();
  });

  test('lists the skills the session loaded and opens each where it lives', async () => {
    const skillCall = (callID: string, id: string, skillDirectory: string): Part => ({
      id: callID, sessionID: sessionId, messageID: 'msg_a', type: 'tool', callID, tool: 'skill',
      state: { status: 'completed', input: { id }, output: '', metadata: { name: id, directory: skillDirectory }, time: { start: 1, end: 2 } },
    });
    const editor = { openFile: async (_path: string) => undefined, openDiff: async () => undefined };
    const openFile = spyOn(editor, 'openFile');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    await render({ ...createWebAPIs(), editor });
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState({
      message: { [sessionId]: [{ id: 'msg_a', sessionID: sessionId, role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm' }] },
      part: { msg_a: [skillCall('c1', 'demo', '/repo/.opencode/skills/demo'), skillCall('c2', 'opencode', 'skill://opencode')] },
    }));
    const row = (name: string) => container.querySelector<HTMLElement>(`[aria-label="Open skill ${name}"]`);
    expect(row('demo')).not.toBeNull();
    expect(row('opencode')).not.toBeNull();

    // VS Code opens a skill file in an editor tab.
    await act(async () => { row('demo')?.click(); });
    expect(openFile.mock.calls).toEqual([['/repo/.opencode/skills/demo/SKILL.md']]);

    // A built-in has no file: Settings opens on it.
    await act(async () => { row('opencode')?.click(); });
    expect(openFile.mock.calls.length).toBe(1);
    expect(useUIStore.getState()).toMatchObject({ isSettingsDialogOpen: true, settingsPage: 'skills.installed' });
    expect(useSkillsStore.getState().selectedSkillName).toBe('opencode');
  });

  test('opens the copy of a skill in the directory the session runs in', async () => {
    // The session runs in a worktree of the active project; each has its own copy.
    const projectRoot = '/project-root';
    const originalProjects = useProjectsStore.getState();
    useProjectsStore.setState({ projects: [{ id: 'root', path: projectRoot }], activeProjectId: 'root' });
    const skillAt = (root: string) => ({ name: 'notes', path: `${root}/.opencode/skills/notes/SKILL.md`, scope: 'project', source: 'opencode' });
    skillsFor = (url) => [skillAt(url.includes(encodeURIComponent(directory)) ? directory : projectRoot)];
    const editor = { openFile: async (_path: string) => undefined, openDiff: async () => undefined };
    const openFile = spyOn(editor, 'openFile');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    await render({ ...createWebAPIs(), editor });
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    // Attached in the composer: the message names the skill but no folder.
    await act(async () => store.setState({
      message: { [sessionId]: [{ id: 'msg_u', sessionID: sessionId, role: 'user', time: { created: 1 }, skills: [{ id: 'notes', name: 'notes' }] }] },
    }));
    await act(async () => { await useSkillsStore.getState().loadSkills(directory); });

    await act(async () => { container.querySelector<HTMLElement>('[aria-label="Open skill notes"]')?.click(); });
    expect(openFile.mock.calls).toEqual([[`${directory}/.opencode/skills/notes/SKILL.md`]]);
    useProjectsStore.setState(originalProjects, true);
  });
});
