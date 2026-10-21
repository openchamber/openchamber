/**
 * The export dialog's state.
 *
 * The dialog lives in its own hook so the Header and the Sidebar can hold it
 * without both of them owning the writing of the file. The caller opens it
 * with the session to export; the dialog asks for the format, the detail
 * level and whether the sub-agent tasks are part of it.
 */

import * as React from 'react';
import { ExportSessionDialog } from './ExportSessionDialog';
import type { ExportFormat } from '@/lib/exportSession';
import type { ProjectionMode } from '@/lib/export/project';
import { listDescendantSessions, readExportSessions } from '@/lib/export/collect';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionExportTarget } from './useSessionExport';

export type ExportChoice = {
  format: ExportFormat;
  mode: ProjectionMode;
  includeSubagents: boolean;
};

export type UseSessionExportDialog = {
  /** The dialog, ready to render. */
  dialog: React.ReactElement;
  /** The target the dialog is open for. */
  target: SessionExportTarget | null;
  /** Opens the dialog for a session. */
  openDialog: (target: SessionExportTarget) => void;
};

/**
 * Holds the export dialog's state and hands back the element to render.
 *
 * The format and the detail level survive the dialog's closing, so a user
 * exporting twice in a row gets the same shape the second time.
 */
export const useSessionExportDialog = (
  onConfirm: (target: SessionExportTarget, choice: ExportChoice) => void,
): UseSessionExportDialog => {
  const [target, setTarget] = React.useState<SessionExportTarget | null>(null);
  const [includeSubagents, setIncludeSubagents] = React.useState(true);
  const [descendantCount, setDescendantCount] = React.useState(0);
  const [format, setFormat] = React.useState<ExportFormat>('markdown');
  const [mode, setMode] = React.useState<ProjectionMode>('readable');

  const openDialog = React.useCallback((next: SessionExportTarget) => {
    setTarget(next);
    // The sub-agent tasks the session has, counted with the same walk the
    // export itself uses, so the number the dialog shows and the number the
    // document carries are one.
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    const allSessions = readExportSessions([...activeSessions, ...archivedSessions]);
    const root = allSessions.find((session) => session.id === next.sessionID);
    const descendants = listDescendantSessions({
      id: next.sessionID,
      title: next.title ?? 'Session',
      parentID: root?.parentID,
      agent: root?.agent,
      createdAt: root?.createdAt,
    }, allSessions);
    setDescendantCount(descendants.length);
    setIncludeSubagents(descendants.length > 0);
  }, []);

  const handleConfirm = React.useCallback((
    nextFormat: ExportFormat,
    nextMode: ProjectionMode,
    include: boolean,
  ) => {
    if (!target) return;
    setTarget(null);
    onConfirm(target, { format: nextFormat, mode: nextMode, includeSubagents: include });
  }, [onConfirm, target]);

  const dialog = React.useMemo(() => (
    <ExportSessionDialog
      open={target !== null}
      onOpenChange={(open) => { if (!open) setTarget(null); }}
      formats={['markdown', 'html', 'json']}
      format={format}
      onFormatChange={setFormat}
      mode={mode}
      onModeChange={setMode}
      descendantCount={descendantCount}
      includeSubagents={includeSubagents}
      onIncludeSubagentsChange={setIncludeSubagents}
      onConfirm={handleConfirm}
    />
  ), [descendantCount, format, handleConfirm, includeSubagents, mode, target]);

  return { dialog, target, openDialog };
};
