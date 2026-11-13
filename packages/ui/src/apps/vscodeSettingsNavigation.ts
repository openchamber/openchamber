import type { VSCodeAPI } from '@/lib/api/types';
import { resolveSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import type { VSCodeSettingsNavigation } from '@/lib/settings/vscodeNavigation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';

export const applyVSCodeSettingsNavigation = (navigation: VSCodeSettingsNavigation): void => {
  const ui = useUIStore.getState();
  const page = resolveSettingsSlug(navigation.page);
  ui.setSettingsProjectPath(navigation.directory ?? null);
  ui.setSettingsProvidersConnectRequested(navigation.connectProvider === true);
  ui.setSettingsProvidersOpenRequested(navigation.providerId ?? null);
  if (navigation.snippetDraft) {
    const snippets = useSnippetsStore.getState();
    snippets.setSnippetDraft(navigation.snippetDraft);
    snippets.setSelectedSnippet(navigation.snippetDraft.name);
  }
  ui.setSettingsPage(page);
  ui.requestSettingsJump(page, navigation.itemId ?? null);
};

/** Chat entry points keep their view while the native host reveals Settings. */
export const connectVSCodeSettingsNavigation = (
  vscode: VSCodeAPI,
  onFailure: (error: Error) => void,
): (() => void) => {
  let active = true;
  let requestRevision = 0;
  const openRequestedSettings = (): void => {
    const ui = useUIStore.getState();
    if (!ui.isSettingsDialogOpen) return;
    const projects = useProjectsStore.getState();
    const jump = ui.settingsJumpRequest;
    const page = ui.settingsJumpRequest?.page ?? ui.settingsPage;
    const draft = page === 'snippets' ? useSnippetsStore.getState().snippetDraft : null;
    const navigation: VSCodeSettingsNavigation = {
      page,
      itemId: ui.settingsJumpRequest?.itemId,
      directory: resolveSettingsDirectory(ui.settingsProjectPath, projects.projects, projects.activeProjectId),
      connectProvider: ui.settingsProvidersConnectRequested,
      providerId: ui.settingsProvidersOpenRequested,
      snippetDraft: draft ? { name: draft.name, scope: draft.scope } : undefined,
    };
    // This flag belongs to an in-page dialog. Leaving it set blocks chat shortcuts.
    ui.setSettingsDialogOpen(false);
    const revision = ++requestRevision;
    void vscode.executeCommand('openchamber.showSettings', navigation).then(() => {
      if (!active || revision !== requestRevision) return;
      const current = useUIStore.getState();
      if (current.settingsJumpRequest === jump) current.clearSettingsJumpRequest();
      if (navigation.connectProvider) current.setSettingsProvidersConnectRequested(false);
      if (current.settingsProvidersOpenRequested === navigation.providerId) current.setSettingsProvidersOpenRequested(null);
      if (draft && useSnippetsStore.getState().snippetDraft === draft) {
        useSnippetsStore.getState().setSnippetDraft(null);
      }
    }).catch((error: Error) => {
      if (active && revision === requestRevision) onFailure(error);
    });
  };
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (state.isSettingsDialogOpen && !previous.isSettingsDialogOpen) openRequestedSettings();
  });
  openRequestedSettings();
  return () => { active = false; unsubscribe(); };
};
