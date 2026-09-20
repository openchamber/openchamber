import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

type GitHubSelection = {
  type: 'issue';
  item: { number: number; title: string };
};

const project = { id: 'project-a', path: '/workspace/project-a' };
let selectGitHubItem: ((selection: GitHubSelection) => void) | null = null;

const projectStoreState = { getActiveProject: () => project };
const githubAuthState = { status: { connected: true }, hasChecked: true };
const linearAuthState = { status: null, hasChecked: true };
const uiState = { isMobile: false };
const gitState = { fetchBranches: async () => undefined };
let worktreeCreations = 0;

const selectProjectState = <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState);
const selectGitHubAuthState = <T,>(selector: (state: typeof githubAuthState) => T): T => selector(githubAuthState);
const selectLinearAuthState = <T,>(selector: (state: typeof linearAuthState) => T): T => selector(linearAuthState);
const selectUIState = <T,>(selector: (state: typeof uiState) => T): T => selector(uiState);
const selectGitState = <T,>(selector: (state: typeof gitState) => T): T => selector(gitState);

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

const actualDialog = await import('@/components/ui/dialog');
const actualDropdownMenu = await import('@/components/ui/dropdown-menu');
const actualCommand = await import('@/components/ui/command');
const actualSessionUIStore = await import('@/sync/session-ui-store');
const actualSessionActions = await import('@/sync/session-actions');
const actualWorktreeManager = await import('@/lib/worktrees/worktreeManager');
const actualBranchNameGenerator = await import('@/lib/git/branchNameGenerator');

mock.module('@/components/ui/dialog', () => ({
  ...actualDialog,
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogTrigger: passthrough,
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
  ...actualDropdownMenu,
  DropdownMenu: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuLabel: passthrough,
  DropdownMenuItem: passthrough,
  DropdownMenuRadioGroup: passthrough,
  DropdownMenuRadioItem: passthrough,
  DropdownMenuSeparator: passthrough,
  DropdownMenuSub: passthrough,
  DropdownMenuSubTrigger: passthrough,
  DropdownMenuSubContent: passthrough,
}));

mock.module('@/components/ui/command', () => ({
  ...actualCommand,
  Command: passthrough,
  CommandEmpty: passthrough,
  CommandGroup: passthrough,
  CommandInput: ({ onValueChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { onValueChange?: (value: string) => void }) => (
    <input {...props} onChange={(event) => onValueChange?.(event.target.value)} />
  ),
  CommandItem: passthrough,
  CommandList: passthrough,
  CommandShortcut: passthrough,
  CommandSeparator: () => null,
}));

mock.module('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/dropdown-trigger', () => ({ dropdownTriggerVariants: () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ') }));

const actualProjectsStore = await import('@/stores/useProjectsStore');
const actualGitHubAuthStore = await import('@/stores/useGitHubAuthStore');
const actualLinearAuthStore = await import('@/stores/useLinearAuthStore');
const actualUIStore = await import('@/stores/useUIStore');
const actualGitStore = await import('@/stores/useGitStore');

mock.module('@/stores/useProjectsStore', () => ({
  ...actualProjectsStore,
  useProjectsStore: selectProjectState,
}));
mock.module('@/stores/useGitHubAuthStore', () => ({
  ...actualGitHubAuthStore,
  useGitHubAuthStore: selectGitHubAuthState,
}));
mock.module('@/stores/useLinearAuthStore', () => ({
  ...actualLinearAuthStore,
  useLinearAuthStore: selectLinearAuthState,
}));
mock.module('@/stores/useUIStore', () => ({
  ...actualUIStore,
  useUIStore: selectUIState,
}));
mock.module('@/sync/session-ui-store', () => ({
  ...actualSessionUIStore,
  materializeOpenDraftSession: async () => null,
  useSessionUIStore: actualSessionUIStore.useSessionUIStore,
}));
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  createSession: async () => null,
  updateSessionTitle: async () => undefined,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ github: {}, git: null, linear: null }),
}));
mock.module('@/stores/useGitStore', () => ({
  ...actualGitStore,
  useGitBranches: () => ({ all: ['main'] }),
  useGitLoadingBranches: () => false,
  useGitStore: selectGitState,
}));
mock.module('@/lib/worktrees/worktreeManager', () => ({
  ...actualWorktreeManager,
  validateWorktreeCreate: async () => ({ ok: true, errors: [] }),
}));
mock.module('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: async () => {
  worktreeCreations += 1;
  return null;
} }));
mock.module('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: async () => undefined }));
mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupCommands: async () => [],
  getWorktreeSetupWaitEnabled: async () => false,
}))
mock.module('@/lib/sharedTrustConfirmation', () => ({
  resolveWorktreeSetupCommands: async () => [],
}));
mock.module('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
mock.module('@/lib/git/branchNameGenerator', () => ({
  ...actualBranchNameGenerator,
  generateBranchSlug: () => 'draft-name',
}));

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
  'HTMLInputElement',
  'KeyboardEvent',
  'Event',
  'HTMLIFrameElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
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
    HTMLInputElement: happyWindow.HTMLInputElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    Event: happyWindow.Event,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
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
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('NewWorktreeDialog behavior', () => {
  for (const isMobile of [false, true]) {
    test(`${isMobile ? 'mobile' : 'desktop'} Enter in branch search does not create a worktree`, async () => {
      const dom = installDom();
      const root = createRoot(dom.container);
      uiState.isMobile = isMobile;
      worktreeCreations = 0;
      try {
        await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
        if (isMobile) {
          const sourcePicker = [...dom.container.querySelectorAll('button')].find((button) => button.textContent === 'main');
          if (!sourcePicker) throw new Error('Missing source branch picker');
          await act(async () => sourcePicker.click());
        }
        const search = dom.container.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]');
        if (!search) throw new Error('Missing branch search input');
        await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(worktreeCreations).toBe(0);
      } finally {
        await act(async () => root.unmount());
        uiState.isMobile = false;
        selectGitHubItem = null;
        dom.restore();
      }
    });
    for (const placeholder of ['feature/my-awesome-feature', 'my-worktree-directory']) {
      test(`${isMobile ? 'mobile' : 'desktop'} Enter in ${placeholder} creates once without reaching global shortcuts`, async () => {
        const dom = installDom();
        const root = createRoot(dom.container);
        uiState.isMobile = isMobile;
        worktreeCreations = 0;
        let globalEnters = 0;
        const globalShortcut = (event: KeyboardEvent) => { if (event.key === 'Enter') globalEnters += 1; };
        window.addEventListener('keydown', globalShortcut);
        try {
          await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
          const input = dom.container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
          if (!input) throw new Error('Missing worktree form field');
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setValue) throw new Error('Missing input value setter');
          await act(async () => {
            setValue.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
          expect(worktreeCreations).toBe(0);
          expect(globalEnters).toBe(0);
          await act(async () => {
            setValue.call(input, 'edited-worktree');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
            await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options })); });
          }
          expect(worktreeCreations).toBe(0);
          globalEnters = 0;
          const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
          await act(async () => { input.dispatchEvent(enter); });
          expect(enter.defaultPrevented).toBe(true);
          expect(worktreeCreations).toBe(1);
          expect(globalEnters).toBe(0);
          await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })); });
          expect(worktreeCreations).toBe(1);
        } finally {
          window.removeEventListener('keydown', globalShortcut);
          await act(async () => root.unmount());
          uiState.isMobile = false;
          selectGitHubItem = null;
          dom.restore();
        }
      });
    }
  }
  test('preserves selected issue values when available worktree names change', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    actualSessionUIStore.useSessionUIStore.setState({ availableWorktreesByProject: new Map() });

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

      const branchInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
      const worktreeInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="my-worktree-directory"]');
      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');

      // SAFETY: Test minimal worktree metadata stub for availableWorktreesByProject
      const worktreeStub = { name: 'newly-created-worktree' } as import('@/types/worktree').WorktreeMetadata;
      await act(async () => actualSessionUIStore.useSessionUIStore.setState({
        availableWorktreesByProject: new Map([
          [project.path, [worktreeStub]],
        ]),
      }));

      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');
    } finally {
      await act(async () => root.unmount());
      actualSessionUIStore.useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
      selectGitHubItem = null;
      dom.restore();
    }
  });
});
