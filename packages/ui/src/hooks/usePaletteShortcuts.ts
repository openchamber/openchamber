import { useKeybinds } from '@/hooks/useKeybind';
import { useI18n } from '@/lib/i18n';
import {
  addProject,
  copyCurrentSessionId,
  openArchive,
  openMultiRun,
  openNewWorktreeDialog,
  openNotes,
  openOverview,
  openTodos,
  pinCurrentSession,
  reloadUi,
  restartOpenCode,
  showContextUsage,
  showDiagnosticTimeline,
  toggleWorkCurrentSession,
} from '@/lib/paletteCommands';

/**
 * Keyboard shortcuts for commands that also appear in the command palette.
 * `MainLayout` mounts this, so the chords work before the palette has ever
 * been opened (the palette itself loads on demand).
 */
export function usePaletteShortcuts(): void {
  const { t } = useI18n();
  useKeybinds({
    open_new_worktree_dialog: openNewWorktreeDialog,
    add_project: addProject,
    show_context_usage: showContextUsage,
    show_opencode_status: showDiagnosticTimeline,
    open_overview: openOverview,
    reload_ui: reloadUi,
    open_archive: openArchive,
    open_notes: openNotes,
    open_todos: openTodos,
    restart_opencode: restartOpenCode(t),
    pin_current_session: pinCurrentSession(t),
    copy_current_session_id: copyCurrentSessionId(t),
    toggle_work_current_session: toggleWorkCurrentSession(t),
    open_multi_run: openMultiRun,
  });
}
