// Characterisation: starting a worktree from a Linear issue names the branch
// `issue-<IDENTIFIER>-<slug>`. The tracker refactor must keep it byte-identical.
// Setup copied from NewWorktreeDialog.behavior.test.tsx.
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

const project = { id: 'project-a', path: '/workspace/project-a' };

const projectStoreState = { getActiveProject: () => project };
const githubAuthState = { status: { connected: true }, hasChecked: true };
const uiState = { isMobile: false };
const gitState = { fetchBranches: async () => undefined };

const selectProjectState = <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState);
const selectSourceControlAuthEntry = () => githubAuthState;
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

mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/dropdown-trigger', () => ({ dropdownTriggerVariants: () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ') }));

const actualProjectsStore = await import('@/stores/useProjectsStore');
const actualSourceControlAuthStore = await import('@/stores/useSourceControlAuthStore');
const actualUIStore = await import('@/stores/useUIStore');
const actualGitStore = await import('@/stores/useGitStore');

mock.module('@/stores/useProjectsStore', () => ({
  ...actualProjectsStore,
  useProjectsStore: selectProjectState,
}));
mock.module('@/stores/useSourceControlAuthStore', () => ({
  ...actualSourceControlAuthStore,
  useSourceControlAuthEntry: selectSourceControlAuthEntry,
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
  useRuntimeAPIs: () => ({ sourceControl: {}, git: null }),
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
mock.module('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: async () => null }));
mock.module('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: async () => undefined }));
mock.module('@/lib/openchamberConfig', () => ({
  getProjectSetup: async () => ({ setupWorktree: ['bun install'] }),
  getWorktreeSetupCommands: async () => [],
  getWorktreeSetupWaitEnabled: async () => false,
}))
mock.module('@/lib/sharedTrustConfirmation', () => ({
  resolveWorktreeSetupCommands: async () => ['trusted-from-project'],
  resolveWorktreeSetupCommandsOrCancel: async () => ['trusted-from-project'],
}));
mock.module('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
mock.module('@/lib/git/branchNameGenerator', () => ({
  ...actualBranchNameGenerator,
  generateBranchSlug: () => 'draft-name',
}));

const actualReferenceSources = await import('@/components/references/referenceSources');
// The project's GitHub read context comes from its binding; these tests never
// reach a PR, so no binding is read.
mock.module('@/components/references/referenceSources', () => ({
  ...actualReferenceSources,
  useRepositoryReadContext: () => null,
  useRepositorySourceStatus: () => 'ready',
  useRepositoryReferenceProvider: () => 'github',
}));
mock.module('@/components/references/ReferencePickerDialog', () => ({ ReferencePickerDialog: () => null }));

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


describe('NewWorktreeDialog from a Linear issue', () => {
  test('names the branch issue-IDENTIFIER-slug and shows the identifier', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeDialog
            open
            onOpenChange={() => undefined}
            initialSelection={{
              source: 'tracker',
              provider: 'linear',
              item: {
                provider: 'linear',
                id: '11111111-2222-3333-4444-555555555555',
                identifier: 'ENG-12',
                title: 'Broken login',
                url: 'https://linear.app/openchamber/issue/ENG-12/broken-login',
                state: { id: 'state-started', name: 'In Progress', category: 'in-progress' },
              },
            }}
          />
        </I18nProvider>,
      ));
      const branchInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
      const worktreeInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="my-worktree-directory"]');
      expect(branchInput?.value).toBe('issue-ENG-12-draft-name');
      expect(worktreeInput?.value).toBe('issue-ENG-12-draft-name');
      expect(dom.container.textContent).toContain('ENG-12');
      expect(dom.container.textContent).toContain('Broken login');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
