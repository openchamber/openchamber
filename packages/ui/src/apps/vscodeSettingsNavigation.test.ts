import { afterEach, describe, expect, test } from 'bun:test';
import type { VSCodeAPI } from '@/lib/api/types';
import { vscodeSettingsNavigationSchema, type VSCodeSettingsNavigation } from '@/lib/settings/vscodeNavigation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';
import { applyVSCodeSettingsNavigation, connectVSCodeSettingsNavigation } from './vscodeSettingsNavigation';

const originalUI = useUIStore.getState();
const originalProjects = useProjectsStore.getState();
const originalSnippets = useSnippetsStore.getState();
let disconnect: (() => void) | undefined;

afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  useUIStore.setState(originalUI, true);
  useProjectsStore.setState(originalProjects, true);
  useSnippetsStore.setState(originalSnippets, true);
});

const connect = (executeCommand: VSCodeAPI['executeCommand']) => {
  disconnect = connectVSCodeSettingsNavigation({ executeCommand, openExternalUrl: async () => undefined }, (error) => { throw error; });
};

describe('VS Code Settings navigation', () => {
  test('hands a Settings request to the host without keeping a chat overlay open', () => {
    const requests: VSCodeSettingsNavigation[] = [];
    useProjectsStore.setState({ projects: [{ id: 'alpha', path: '/work/alpha' }, { id: 'beta', path: '/work/beta' }], activeProjectId: 'alpha' });
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'mcp', settingsProjectPath: '/work/beta', settingsJumpRequest: { page: 'mcp', itemId: 'mcp.create' } });
    connect(async (command, input) => {
      expect(command).toBe('openchamber.showSettings');
      requests.push(vscodeSettingsNavigationSchema.parse(input));
    });
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(requests).toEqual([{ page: 'mcp', itemId: 'mcp.create', directory: '/work/beta', connectProvider: false, providerId: null }]);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    useUIStore.getState().setShowReasoningTraces(false);
    expect(requests.length).toBe(1);
  });

  test('preserves provider-connect and new-snippet entry intent', () => {
    const requests: VSCodeSettingsNavigation[] = [];
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'providers', settingsJumpRequest: null, settingsProvidersConnectRequested: true });
    connect(async (_command, input) => { requests.push(vscodeSettingsNavigationSchema.parse(input)); });
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(requests[0]?.connectProvider).toBe(true);
    useUIStore.setState({ settingsPage: 'snippets', settingsProvidersConnectRequested: false });
    useSnippetsStore.getState().setSnippetDraft({ name: 'new-snippet', scope: 'global' });
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(requests[1]?.snippetDraft).toEqual({ name: 'new-snippet', scope: 'global' });
  });

  test('consumes accepted entry intent and ignores an older command completion', async () => {
    const completions: Array<() => void> = [];
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'providers', settingsJumpRequest: null, settingsProvidersConnectRequested: true });
    connect(() => new Promise((resolve) => { completions.push(() => resolve(undefined)); }));
    useUIStore.getState().setSettingsDialogOpen(true);
    useUIStore.getState().setSettingsDialogOpen(true);
    completions[0]?.();
    await Promise.resolve();
    expect(useUIStore.getState().settingsProvidersConnectRequested).toBe(true);
    completions[1]?.();
    await Promise.resolve();
    expect(useUIStore.getState().settingsProvidersConnectRequested).toBe(false);
  });

  test('applies a delivered target without changing the active chat project', () => {
    useProjectsStore.setState({ projects: [{ id: 'alpha', path: '/work/alpha' }, { id: 'beta', path: '/work/beta' }], activeProjectId: 'alpha' });
    applyVSCodeSettingsNavigation({ page: 'providers', directory: '/work/beta', connectProvider: true, itemId: 'providers.connect' });
    const ui = useUIStore.getState();
    expect(ui.settingsPage).toBe('providers');
    expect(ui.settingsProjectPath).toBe('/work/beta');
    expect(ui.settingsProvidersConnectRequested).toBe(true);
    expect(ui.settingsJumpRequest).toEqual({ page: 'providers', itemId: 'providers.connect' });
    expect(useProjectsStore.getState().activeProjectId).toBe('alpha');
    applyVSCodeSettingsNavigation({ page: 'snippets', snippetDraft: { name: 'new-snippet', scope: 'project' } });
    expect(useSnippetsStore.getState().selectedSnippetName).toBe('new-snippet');
    expect(useSnippetsStore.getState().snippetDraft).toEqual({ name: 'new-snippet', scope: 'project' });
  });

  test('reports a failed native request and leaves its intent available for retry', async () => {
    const error = new Error('Native tab unavailable');
    const failures: Error[] = [];
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'providers', settingsProvidersConnectRequested: true });
    const reported = new Promise<void>((resolve) => {
      disconnect = connectVSCodeSettingsNavigation({ executeCommand: async () => { throw error; }, openExternalUrl: async () => undefined }, (failure) => {
        failures.push(failure);
        resolve();
      });
    });
    useUIStore.getState().setSettingsDialogOpen(true);
    await reported;
    expect(failures).toEqual([error]);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    expect(useUIStore.getState().settingsProvidersConnectRequested).toBe(true);
  });

  test('stops handing off requests after the chat root unmounts', () => {
    let requests = 0;
    useUIStore.setState({ isSettingsDialogOpen: false });
    connect(async () => { requests += 1; });
    disconnect?.();
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(requests).toBe(0);
  });

  test('rejects malformed bridge targets and strips unrelated fields', () => {
    for (const input of [null, [], { page: '' }, { page: 'providers', connectProvider: 'yes' }, { page: 'snippets', snippetDraft: { name: 'x', scope: 'foreign' } }]) {
      expect(vscodeSettingsNavigationSchema.safeParse(input).success).toBe(false);
    }
    expect(vscodeSettingsNavigationSchema.parse({ page: ' appearance ', credentials: 'never forwarded' })).toEqual({ page: 'appearance' });
  });
});
