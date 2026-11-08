import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { copyTextToClipboard } from '@/lib/clipboard';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { restartOpenCodeWithFeedback } from '@/lib/restartOpenCode';
import { sessionEvents } from '@/lib/sessionEvents';
import { isSessionPinned } from '@/lib/sessionPins';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { setSessionWorkState } from '@/sync/session-actions';
import { toggleSessionPin } from '@/sync/session-pins';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/**
 * A command's behavior, shared by its command palette entry and its keyboard
 * shortcut so the two cannot drift. Returns `false` when the command does not
 * apply right now, which lets another registration take the chord and tells
 * the palette nothing ran. Only `MainLayout` (web and desktop) mounts these;
 * VS Code and the mobile apps have neither the commands nor the Shortcuts page.
 */
type PaletteCommand = () => boolean | void;

export const addProject: PaletteCommand = () => {
  sessionEvents.requestDirectoryDialog();
};

export const openNewWorktreeDialog: PaletteCommand = () => {
  useUIStore.getState().setNewWorktreeDialogOpen(true);
};

export const showContextUsage: PaletteCommand = () => {
  const directory = useDirectoryStore.getState().currentDirectory;
  if (!directory) return false;
  useUIStore.getState().openContextOverview(directory);
};

export const showDiagnosticTimeline: PaletteCommand = () => {
  void showOpenCodeStatus();
};

export const openOverview: PaletteCommand = () => {
  if (!useUIStore.getState().overviewFeatureAvailable) return false;
  useUIStore.getState().setOverviewOpen(true);
};

export const reloadUi: PaletteCommand = () => {
  window.location.reload();
};

export const openArchive: PaletteCommand = () => {
  const ui = useUIStore.getState();
  ui.setSessionSwitcherOpen(false);
  ui.setArchivePageOpen(true);
};

const openProjectNotesTab = (tab: 'notes' | 'todos'): boolean => {
  const directory = useDirectoryStore.getState().currentDirectory;
  if (!directory) return false;
  const ui = useUIStore.getState();
  ui.setProjectContextTab(tab);
  ui.openContextSurface(directory, 'notes');
  return true;
};

export const openNotes: PaletteCommand = () => openProjectNotesTab('notes');

export const openTodos: PaletteCommand = () => openProjectNotesTab('todos');

export const restartOpenCode = (t: Translate): PaletteCommand => () => {
  void restartOpenCodeWithFeedback(t);
};

export const pinCurrentSession = (t: Translate): PaletteCommand => () => {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  const directory = useDirectoryStore.getState().currentDirectory;
  if (!sessionId || !directory) return false;
  const failedKey = isSessionPinned(useSessionPinnedStore.getState().ids, directory, sessionId)
    ? 'sessions.sidebar.session.pin.unpinFailed'
    : 'sessions.sidebar.session.pin.pinFailed';
  void toggleSessionPin({ directory, sessionId }).catch(() => toast.error(t(failedKey)));
};

export const copyCurrentSessionId = (t: Translate): PaletteCommand => () => {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  if (!sessionId) return false;
  void copyTextToClipboard(sessionId)
    .then((result) => {
      if (result.ok) {
        toast.success(t('sessions.sidebar.session.copyId.success'));
        return;
      }
      toast.error(t('sessions.sidebar.session.copyId.error'));
    })
    .catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
};

export const toggleWorkCurrentSession = (t: Translate): PaletteCommand => () => {
  if (!useUIStore.getState().sessionWorkEnabled) return false;
  const sessionId = useSessionUIStore.getState().currentSessionId;
  if (!sessionId) return false;
  const session = useGlobalSessionsStore.getState().activeSessions.find((entry) => entry.id === sessionId);
  if (!session || session.parentID) return false;
  const directory = resolveGlobalSessionDirectory(session) ?? useDirectoryStore.getState().currentDirectory;
  if (!directory || isChatDirectoryPath(directory)) return false;
  const next = isSessionInWork(session) ? 'done' : 'open';
  void setSessionWorkState(sessionId, directory, next)
    .catch(() => toast.error(t('sessions.sidebar.session.work.updateFailed')));
};

export const openMultiRun: PaletteCommand = () => {
  useUIStore.getState().setSessionSwitcherOpen(false);
  openParallelComposer();
};
