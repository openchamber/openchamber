import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { AgentWithExtras } from '@/stores/useAgentsStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});

const DIRECTORY = '/workspace/project';

type ListedAgent = {
  id: string;
  name: string;
  displayName: string;
  mode: string;
  hidden: boolean;
  request: { settings: Record<string, never>; headers: Record<string, never>; body: Record<string, never> };
  permissions: unknown[];
};

let listedAgents: ListedAgent[] = [];
// While set, a list request answers with the list as it was when the request
// arrived, but only once the gate opens: a slow read that predates a change.
let listGate: Promise<void> | null = null;
let listRequests = 0;
let agentConfigResponses = new Map<string, unknown>();
const consumedConfigLookups: string[] = [];

const pathnameOf = (url: string): string => {
  try {
    return new URL(url, 'http://localhost/').pathname;
  } catch {
    return url;
  }
};

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const path = pathnameOf(url);
  if (path.startsWith('/api/config/agents/')) {
    const name = decodeURIComponent(path.slice('/api/config/agents/'.length));
    const payload = agentConfigResponses.get(name);
    if (payload === undefined) {
      return Response.json({ error: 'no mocked config-entity response' }, { status: 404 });
    }
    consumedConfigLookups.push(name);
    return Response.json(payload);
  }
  // The SDK's agent list request. The config-entity route above already
  // consumed its own path prefix, so the remaining /agent hit is the list.
  if (path === '/agent' || path.endsWith('/agent')) {
    listRequests += 1;
    const snapshot = listedAgents;
    if (listGate) await listGate;
    return Response.json({ data: snapshot });
  }
  // The store import chain probes location and sessions for system info;
  // well-shaped empty answers keep that background probing quiet.
  if (path.includes('/location')) {
    return Response.json({ directory: DIRECTORY, project: { directory: DIRECTORY } });
  }
  if (path.includes('/session')) {
    return Response.json({ data: [], pagination: {} });
  }
  return Response.json({ data: [] });
});

const { useAgentsStore, invalidateAgentsLoadCache, isAgentBuiltIn } = await import('@/stores/useAgentsStore');

const sdkAgent = (name: string, mode: 'primary' | 'subagent'): ListedAgent => ({
  id: name,
  name,
  displayName: name,
  mode,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

beforeEach(() => {
  listedAgents = [];
  agentConfigResponses = new Map();
  consumedConfigLookups.length = 0;
  listGate = null;
  listRequests = 0;
  invalidateAgentsLoadCache(DIRECTORY);
  useAgentsStore.setState({ agents: [], agentsByDirectory: {}, isLoading: false });
});

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

describe('useAgentsStore built-in classification', () => {
  test('an agent with no md or json source is classified as built-in', async () => {
    listedAgents = [sdkAgent('build', 'primary'), sdkAgent('deploy', 'subagent')];
    agentConfigResponses.set('build', {
      name: 'build',
      scope: null,
      sources: { md: { exists: false }, json: { exists: false } },
      isBuiltIn: true,
    });
    agentConfigResponses.set('deploy', {
      name: 'deploy',
      scope: 'user',
      sources: { md: { exists: true, scope: 'user', path: '/home/u/.config/opencode/agents/deploy.md' } },
      isBuiltIn: false,
    });

    await useAgentsStore.getState().loadAgents(DIRECTORY);

    const agents = useAgentsStore.getState().agentsByDirectory[DIRECTORY] ?? [];
    const build = agents.find((agent) => agent.name === 'build');
    const deploy = agents.find((agent) => agent.name === 'deploy');

    expect(consumedConfigLookups).toEqual(['build', 'deploy']);
    expect(build && isAgentBuiltIn(build)).toBe(true);
    expect(deploy && isAgentBuiltIn(deploy)).toBe(false);
  });

  test('an agent defined in a config file stays custom', async () => {
    listedAgents = [sdkAgent('deploy', 'subagent')];
    agentConfigResponses.set('deploy', {
      name: 'deploy',
      scope: 'user',
      sources: { md: { exists: true, scope: 'user', path: '/home/u/.config/opencode/agents/deploy.md' } },
    });

    await useAgentsStore.getState().loadAgents(DIRECTORY);

    const agents = useAgentsStore.getState().agentsByDirectory[DIRECTORY] ?? [];
    const deploy = agents.find((agent) => agent.name === 'deploy');

    expect(consumedConfigLookups).toEqual(['deploy']);
    expect(deploy && isAgentBuiltIn(deploy)).toBe(false);
  });

  test('a config-entity response without isBuiltIn keeps the agent custom', async () => {
    listedAgents = [sdkAgent('build', 'primary')];
    agentConfigResponses.set('build', {
      name: 'build',
      scope: null,
      sources: { md: { exists: false }, json: { exists: false } },
    });

    await useAgentsStore.getState().loadAgents(DIRECTORY);

    const agents = useAgentsStore.getState().agentsByDirectory[DIRECTORY] ?? [];
    const build = agents.find((agent) => agent.name === 'build');

    expect(consumedConfigLookups).toEqual(['build']);
    expect(build && isAgentBuiltIn(build)).toBe(false);
  });
});

const waitUntil = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const agentNames = (): string[] =>
  (useAgentsStore.getState().agentsByDirectory[DIRECTORY] ?? []).map((agent) => agent.name);

describe('useAgentsStore built-in agents and their definition files', () => {
  test('a built-in agent has no file behind it; a file-overridden one is custom', async () => {
    listedAgents = [sdkAgent('ghost-plugin', 'subagent'), sdkAgent('build', 'primary')];
    // The shapes the config-entity route returns: isBuiltIn means neither an
    // md file nor a JSON entry exists, so there is never an override to reset.
    agentConfigResponses.set('ghost-plugin', {
      name: 'ghost-plugin',
      scope: null,
      sources: { md: { exists: false, path: null }, json: { exists: false } },
      isBuiltIn: true,
    });
    agentConfigResponses.set('build', {
      name: 'build',
      scope: 'user',
      sources: { md: { exists: true, scope: 'user', path: '/home/u/.config/opencode/agents/build.md' }, json: { exists: false } },
      isBuiltIn: false,
    });

    await useAgentsStore.getState().loadAgents(DIRECTORY);

    const agents: AgentWithExtras[] = useAgentsStore.getState().agentsByDirectory[DIRECTORY] ?? [];
    const ghost = agents.find((agent) => agent.name === 'ghost-plugin');
    const build = agents.find((agent) => agent.name === 'build');
    expect(ghost && isAgentBuiltIn(ghost)).toBe(true);
    expect(ghost?.path).toBeNull();
    expect(build && isAgentBuiltIn(build)).toBe(false);
    expect(build?.path).toBe('/home/u/.config/opencode/agents/build.md');
  });
});

describe('useAgentsStore load generations', () => {
  test('a load after an invalidation reads again instead of joining an older read', async () => {
    listedAgents = [sdkAgent('build', 'primary'), sdkAgent('deploy', 'subagent')];
    let openGate = () => {};
    listGate = new Promise((resolve) => { openGate = resolve; });

    const first = useAgentsStore.getState().loadAgents(DIRECTORY);
    await waitUntil(() => listRequests === 1);

    // `deploy` is deleted while that read is still open.
    listedAgents = [sdkAgent('build', 'primary')];
    invalidateAgentsLoadCache(DIRECTORY);
    const second = useAgentsStore.getState().loadAgents(DIRECTORY);
    listGate = null;
    openGate();

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(listRequests).toBe(2);
    expect(agentNames()).toEqual(['build']);
  });

  test('a load without an invalidation joins the read already in flight', async () => {
    listedAgents = [sdkAgent('build', 'primary')];
    let openGate = () => {};
    listGate = new Promise((resolve) => { openGate = resolve; });

    const first = useAgentsStore.getState().loadAgents(DIRECTORY);
    await waitUntil(() => listRequests === 1);
    const second = useAgentsStore.getState().loadAgents(DIRECTORY);
    openGate();

    await Promise.all([first, second]);
    expect(listRequests).toBe(1);
    expect(agentNames()).toEqual(['build']);
  });
});
