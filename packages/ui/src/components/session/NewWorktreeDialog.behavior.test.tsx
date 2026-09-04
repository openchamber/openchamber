import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';

type GitHubSelection = {
  type: 'issue';
  item: { number: number; title: string };
};

type WorktreeState = {
  availableWorktreesByProject: Map<string, Array<{ name: string }>>;
};

const project = { id: 'project-a', path: '/workspace/project-a' };
const useWorktreeStore = create<WorktreeState>(() => ({
  availableWorktreesByProject: new Map(),
}));
let selectGitHubItem: ((selection: GitHubSelection) => void) | null = null;

const projectStoreState = { getActiveProject: () => project };
const githubAuthState = { status: { connected: true }, hasChecked: true };
const linearAuthState = { status: null, hasChecked: true };
const uiState = { isMobile: false };
const gitState = { fetchBranches: async () => undefined };

const selectProjectState = <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState);
const selectGitHubAuthState = <T,>(selector: (state: typeof githubAuthState) => T): T => selector(githubAuthState);
const selectLinearAuthState = <T,>(selector: (state: typeof linearAuthState) => T): T => selector(linearAuthState);
const selectUIState = <T,>(selector: (state: typeof uiState) => T): T => selector(uiState);
const selectGitState = <T,>(selector: (state: typeof gitState) => T): T => selector(gitState);

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogFooter: passthrough,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined },
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuTrigger: passthrough,
}));

mock.module('@/components/ui/command', () => ({
  Command: passthrough,
  CommandEmpty: passthrough,
  CommandGroup: passthrough,
  CommandInput: () => null,
  CommandItem: passthrough,
  CommandList: passthrough,
  CommandSeparator: () => null,
}));

mock.module('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: passthrough }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/dropdown-trigger', () => ({ dropdownTriggerVariants: () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ') }));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: selectProjectState,
}));
mock.module('@/stores/useGitHubAuthStore', () => ({
  useGitHubAuthStore: selectGitHubAuthState,
}));
mock.module('@/stores/useLinearAuthStore', () => ({
  useLinearAuthStore: selectLinearAuthState,
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: selectUIState,
}));
mock.module('@/sync/session-ui-store', () => ({
  materializeOpenDraftSession: async () => null,
  useSessionUIStore: useWorktreeStore,
}));
mock.module('@/sync/session-actions', () => ({
  createSession: async () => null,
  updateSessionTitle: async () => undefined,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ github: {}, git: null, linear: null }),
}));
mock.module('@/stores/useGitStore', () => ({
  useGitBranches: () => ({ all: ['main'] }),
  useGitLoadingBranches: () => false,
  useGitStore: selectGitState,
}));
mock.module('@/lib/worktrees/worktreeManager', () => ({
  validateWorktreeCreate: async () => ({ ok: true, errors: [] }),
}));
mock.module('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: async () => null }));
mock.module('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: async () => undefined }));
mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupCommands: async () => [],
  getWorktreeSetupWaitEnabled: async () => false,
}));
mock.module('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
mock.module('@/lib/git/branchNameGenerator', () => ({ generateBranchSlug: () => 'draft-name' }));

mock.module('./GitHubIntegrationDialog', () => ({
  GitHubIntegrationDialog: ({ onSelect }: { onSelect: (selection: GitHubSelection) => void }) => {
    selectGitHubItem = onSelect;
    return null;
  },
}));
mock.module('./LinearIssuePickerDialog', () => ({ LinearIssuePickerDialog: () => null }));

const { NewWorktreeDialog } = await import('./NewWorktreeDialog');
const { I18nProvider } = await import('@/lib/i18n');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLIFrameElement',
  'localStorage',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('NewWorktreeDialog behavior', () => {
  test('preserves selected issue values when available worktree names change', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    useWorktreeStore.setState({ availableWorktreesByProject: new Map() });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeDialog open onOpenChange={() => undefined} />
        </I18nProvider>,
      ));
      if (!selectGitHubItem) throw new Error('Expected GitHub selection handler');

      await act(async () => selectGitHubItem?.({
        type: 'issue',
        item: { number: 42, title: 'Keep the selected issue' },
      }));

      const [branchInput, worktreeInput] = dom.container.querySelectorAll<HTMLInputElement>('input');
      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');

      await act(async () => useWorktreeStore.setState({
        availableWorktreesByProject: new Map([
          [project.path, [{ name: 'newly-created-worktree' }]],
        ]),
      }));

      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');
    } finally {
      await act(async () => root.unmount());
      selectGitHubItem = null;
      dom.restore();
    }
  });
});
