import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Spy } from 'bun:test';
import { Window } from 'happy-dom';
import type { JsonValue } from '@openchamber/sdk';
import type { Root } from 'react-dom/client';

// React decides at import time whether a DOM exists, so the window comes first.
const win = new Window({ url: 'http://localhost' });
const browserGlobals = {
  window: win, document: win.document, navigator: win.navigator,
  Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  SVGElement: win.SVGElement, Document: win.Document, DocumentFragment: win.DocumentFragment,
  DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent, FocusEvent: win.FocusEvent,
  MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
  localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(Object.keys(browserGlobals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(browserGlobals)) Object.defineProperty(globalThis, key, { configurable: true, value });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { getDefaultMagicPromptTemplate } = await import('@/lib/magicPrompts');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useMagicPromptsStore } = await import('@/stores/useMagicPromptsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { MagicPromptsPage } = await import('./MagicPromptsPage');

afterAll(async () => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

// A stand-in for the /api/magic-prompts routes
// (packages/web/server/lib/magic-prompts/DOCUMENTATION.md). A mutation changes
// the stored maps and answers with the view the real route returns.

type Call = { url: URL; method: string; body: string | null };
type Prompts = { [id: string]: string };
type Stored = { kind: 'ok'; prompts: Prompts } | { kind: 'missing' } | { kind: 'invalid'; reason: string };

const VISIBLE = 'git.commit.generate.visible';
const INSTRUCTIONS = 'git.commit.generate.instructions';
const BUILTIN_VISIBLE = getDefaultMagicPromptTemplate(VISIBLE);

const json = (body: JsonValue, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
);

const server: { global: Stored; projects: Map<string, { path: string; stored: Stored }> } = { global: { kind: 'missing' }, projects: new Map() };
let calls: Call[];
let request: Spy<typeof fetch>;
// Holds back the answer to the next matching request until `release` runs.
// The answer is computed when the request arrives, as a real server would.
let held: { match: (call: Call) => boolean; gate: Promise<void> } | null = null;
const holdNext = (match: (call: Call) => boolean): (() => Promise<void>) => {
  let resolve = () => {};
  const gate = new Promise<void>((done) => { resolve = done; });
  held = { match, gate };
  return async () => {
    await act(async () => {
      resolve();
      await flush();
    });
  };
};

const scopeState = (stored: Stored): JsonValue => (
  stored.kind === 'invalid'
    ? { status: 'invalid', reason: stored.reason }
    : { status: stored.kind, overrides: stored.kind === 'ok' ? stored.prompts : {} }
);

const view = (projectId: string): Response => {
  const project = server.projects.get(projectId);
  if (!project) return json({ error: 'Project not found', code: 'project_not_found' }, 404);
  return json({
    version: 1,
    project: { id: projectId, path: project.path, file: '.openchamber/project.json' },
    scopes: { global: scopeState(server.global), project: scopeState(project.stored) },
  });
};

const legacyGlobal = (): Response => (
  server.global.kind === 'invalid'
    ? json({ error: 'Global magic prompts cannot be read', code: 'global_prompts_invalid' }, 409)
    : json({ version: 1, overrides: server.global.kind === 'ok' ? server.global.prompts : {} })
);

const mutate = (stored: Stored, call: Call, id: string | null): Stored => {
  const prompts: Prompts = stored.kind === 'ok' ? { ...stored.prompts } : {};
  if (call.method === 'PUT' && id) {
    const body: { text: string } = JSON.parse(call.body ?? '{}');
    prompts[id] = body.text;
  } else if (id) {
    delete prompts[id];
  } else {
    return { kind: 'missing' };
  }
  return Object.keys(prompts).length > 0 ? { kind: 'ok', prompts } : { kind: 'missing' };
};

const handle = (call: Call): Response => {
  const scope = call.url.searchParams.get('scope');
  const projectId = call.url.searchParams.get('projectId');
  const prefix = '/api/magic-prompts/';
  const id = call.url.pathname.startsWith(prefix) ? decodeURIComponent(call.url.pathname.slice(prefix.length)) : null;
  if (call.method === 'GET') return projectId ? view(projectId) : legacyGlobal();
  if (scope === 'project' && projectId) {
    const project = server.projects.get(projectId);
    if (!project) return json({ error: 'Project not found', code: 'project_not_found' }, 404);
    project.stored = mutate(project.stored, call, id);
    return view(projectId);
  }
  server.global = mutate(server.global, call, id);
  return scope === 'global' && projectId ? view(projectId) : legacyGlobal();
};

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const promptCalls = () => calls.filter((call) => call.url.pathname.startsWith('/api/magic-prompts'));
const lastCall = () => {
  const call = promptCalls().at(-1);
  return call ? `${call.method} ${call.url.pathname}${call.url.search}` : null;
};

let initialProjects: ReturnType<typeof useProjectsStore.getState>;
let initialUI: ReturnType<typeof useUIStore.getState>;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  held = null;
  server.global = { kind: 'missing' };
  server.projects = new Map();
  calls = [];
  request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call: Call = { url: new URL(String(input)), method: String(init?.method ?? 'GET'), body: init?.body == null ? null : String(init.body) };
    // A runtime switch refreshes its URL token; that request is not under test.
    if (call.url.pathname === '/auth/url-token') return json({ token: 'test-url-token', expiresAt: Date.now() + 60_000 });
    calls.push(call);
    if (!call.url.pathname.startsWith('/api/magic-prompts')) return json({ error: 'Not part of this test' }, 404);
    const response = handle(call);
    if (held?.match(call)) {
      const { gate } = held;
      held = null;
      await gate;
    }
    return response;
  });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });

  initialProjects = useProjectsStore.getState();
  initialUI = useUIStore.getState();
  useMagicPromptsStore.getState().setSelectedPromptId('git.commit.generate');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  request.mockRestore();
  useProjectsStore.setState(initialProjects);
  useUIStore.setState(initialUI);
  container.remove();
});

const useProjects = (projects: Array<{ id: string; path: string; label?: string }>, options: { active?: string; settings?: string | null } = {}) => {
  for (const project of projects) server.projects.set(project.id, { path: project.path, stored: { kind: 'missing' } });
  useProjectsStore.setState({ projects, activeProjectId: options.active ?? projects[0]?.id ?? null });
  useUIStore.setState({ settingsProjectPath: options.settings ?? null });
};

const mount = async () => {
  await act(async () => {
    root.render(<ThemeSystemProvider><I18nProvider><MagicPromptsPage /></I18nProvider></ThemeSystemProvider>);
    await flush();
  });
};

type Block = 'Visible prompt' | 'Instructions';

const field = (label: Block): HTMLTextAreaElement | null => (
  container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
);

const statusOf = (label: Block): string | undefined => (
  field(label)?.closest('section')?.querySelector('[data-magic-prompt-status]')?.textContent ?? undefined
);

const buttonIn = (scopeElement: ParentNode, text: string): HTMLButtonElement => {
  const match = Array.from(scopeElement.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent?.trim() === text);
  if (!match) throw new Error(`No button "${text}"`);
  return match;
};

const blockButton = (label: Block, text: string): HTMLButtonElement => {
  const section = field(label)?.closest('section');
  if (!section) throw new Error(`No editor "${label}"`);
  return buttonIn(section, text);
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await flush();
  });
};

const chooseScope = (chipLabel: string) => click(buttonIn(container, chipLabel));

const type = async (label: Block, value: string) => {
  const element = field(label);
  if (!element) throw new Error(`No editor "${label}"`);
  await act(async () => {
    // The globals are happy-dom's (set above), typed as the DOM's.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
};

const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

test('opens on Global and edits the project the Settings selector names, never the chat project', async () => {
  useProjects([
    { id: 'chat', path: '/work/chat' },
    { id: 'parent', path: '/work/parent' },
    { id: 'parent-wt', path: '/work/parent/.worktrees/feature' },
  ], { active: 'chat', settings: '/work/parent' });
  server.global = { kind: 'ok', prompts: { [VISIBLE]: 'Global visible' } };

  await mount();
  expect(buttonIn(container, 'Global').getAttribute('aria-pressed')).toBe('true');
  expect(statusOf('Visible prompt')).toBe('Using global override');

  await chooseScope('Project');
  expect(lastCall()).toBe('GET /api/magic-prompts?projectId=parent');
  expect(field('Visible prompt')?.value).toBe('Global visible');
  expect(statusOf('Visible prompt')).toBe('Inherited from global override');

  // A worktree registered as a project of its own keeps its own identity.
  await act(async () => {
    useUIStore.setState({ settingsProjectPath: '/work/parent/.worktrees/feature' });
    await flush();
  });
  expect(lastCall()).toBe('GET /api/magic-prompts?projectId=parent-wt');
  expect(useProjectsStore.getState().activeProjectId).toBe('chat');
});

test('save, reset and reset all change only the selected scope', async () => {
  useProjects([{ id: 'proj', path: '/work/proj' }]);
  server.global = { kind: 'ok', prompts: { [VISIBLE]: 'Global visible', [INSTRUCTIONS]: 'Global instructions' } };
  server.projects.get('proj')!.stored = { kind: 'ok', prompts: { [VISIBLE]: 'Project visible' } };

  await mount();
  await chooseScope('Project');
  expect(statusOf('Visible prompt')).toBe('Using project override');
  await click(blockButton('Visible prompt', 'Remove project override'));
  expect(lastCall()).toBe(`DELETE /api/magic-prompts/${VISIBLE}?scope=project&projectId=proj`);
  expect(field('Visible prompt')?.value).toBe('Global visible');

  await type('Instructions', 'Project instructions');
  await click(blockButton('Instructions', 'Save'));
  expect(lastCall()).toBe(`PUT /api/magic-prompts/${INSTRUCTIONS}?scope=project&projectId=proj`);
  await click(buttonIn(container, 'Remove all project overrides'));
  expect(field('Instructions')?.value).toBe('Global instructions');
  expect(server.projects.get('proj')!.stored).toEqual({ kind: 'missing' });

  server.projects.get('proj')!.stored = { kind: 'ok', prompts: { [VISIBLE]: 'Project visible' } };
  await chooseScope('Global');
  await click(buttonIn(container, 'Reset all overrides'));
  expect(lastCall()).toBe('DELETE /api/magic-prompts');
  expect(field('Visible prompt')?.value).toBe(BUILTIN_VISIBLE);
  expect(server.projects.get('proj')!.stored).toEqual({ kind: 'ok', prompts: { [VISIBLE]: 'Project visible' } });
});

test('built-in text saved in Project stays an override, and in Global removes the override', async () => {
  useProjects([{ id: 'proj', path: '/work/proj' }]);
  server.global = { kind: 'ok', prompts: { [VISIBLE]: 'Global visible' } };

  await mount();
  await chooseScope('Project');
  await type('Visible prompt', BUILTIN_VISIBLE);
  await click(blockButton('Visible prompt', 'Save'));
  expect(lastCall()).toBe(`PUT /api/magic-prompts/${VISIBLE}?scope=project&projectId=proj`);
  expect(statusOf('Visible prompt')).toBe('Using project override');

  await chooseScope('Global');
  await type('Visible prompt', BUILTIN_VISIBLE);
  await click(blockButton('Visible prompt', 'Save'));
  expect(lastCall()).toBe(`DELETE /api/magic-prompts/${VISIBLE}`);
});

test('an unreadable scope shows the error with Retry, never editable built-in text', async () => {
  useProjects([{ id: 'proj', path: '/work/proj' }]);
  server.projects.get('proj')!.stored = { kind: 'invalid', reason: 'Unexpected token' };

  await mount();
  await chooseScope('Project');
  expect(field('Visible prompt')).toBeNull();
  expect(alertText()).toContain('The project file cannot be read: Unexpected token');

  // The global scope is read on its own and stays editable.
  await chooseScope('Global');
  expect(field('Visible prompt')?.value).toBe(BUILTIN_VISIBLE);

  await chooseScope('Project');
  expect(field('Visible prompt')).toBeNull();
  server.projects.get('proj')!.stored = { kind: 'missing' };
  await click(buttonIn(container, 'Retry'));
  expect(alertText()).toBeNull();
  expect(field('Visible prompt')?.value).toBe(BUILTIN_VISIBLE);
});

test('a read that started before a save never replaces what the save answered', async () => {
  server.global = { kind: 'ok', prompts: { [VISIBLE]: 'Old visible' } };
  useProjects([{ id: 'proj', path: '/work/proj' }]);
  await mount();
  await chooseScope('Project');
  // Coming back to Global reads it again; that read answers late, with the old text.
  const releaseRead = holdNext((call) => call.method === 'GET' && !call.url.searchParams.has('projectId'));
  await chooseScope('Global');
  await type('Visible prompt', 'New visible');
  await click(blockButton('Visible prompt', 'Save'));
  await releaseRead();

  expect(field('Visible prompt')?.value).toBe('New visible');
  expect(statusOf('Visible prompt')).toBe('Using global override');
});

test('a context runs one write at a time', async () => {
  await mount();
  const releaseSave = holdNext((call) => call.method === 'PUT');
  await type('Visible prompt', 'First');
  await click(blockButton('Visible prompt', 'Save'));
  await type('Instructions', 'Second');
  await click(blockButton('Instructions', 'Save'));
  expect(promptCalls().filter((call) => call.method === 'PUT')).toHaveLength(1);
  await releaseSave();
  expect(server.global).toEqual({ kind: 'ok', prompts: { [VISIBLE]: 'First' } });
});

test('text typed while a save is in flight stays in the editor', async () => {
  await mount();
  const releaseSave = holdNext((call) => call.method === 'PUT');
  await type('Visible prompt', 'Saved text');
  await click(blockButton('Visible prompt', 'Save'));
  await type('Visible prompt', 'Saved text, and more');
  await releaseSave();

  expect(field('Visible prompt')?.value).toBe('Saved text, and more');
  expect(server.global).toEqual({ kind: 'ok', prompts: { [VISIBLE]: 'Saved text' } });
});
