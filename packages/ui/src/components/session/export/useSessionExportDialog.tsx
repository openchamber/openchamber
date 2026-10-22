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
 * Counts the sub-agent tasks a session has.
 *
 * The count comes from the walk the export itself makes, so the number the
 * dialog shows and the number the document carries are one.
 */
type SubagentCounter = (target: SessionExportTarget) => Promise<number>;

/**
 * Holds the export dialog's state and hands back the element to render.
 *
 * The format and the detail level survive the dialog's closing, so a user
 * exporting twice in a row gets the same shape the second time. The coverage
 * survives it too, and it belongs to the session: the choice a reader made
 * for one session reaches that session and no other.
 */
export const useSessionExportDialog = (
  onConfirm: (target: SessionExportTarget, choice: ExportChoice) => void,
  countSubagents: SubagentCounter,
): UseSessionExportDialog => {
  const [target, setTarget] = React.useState<SessionExportTarget | null>(null);
  const [includeSubagents, setIncludeSubagents] = React.useState(true);
  const [descendantCount, setDescendantCount] = React.useState(0);
  /**
   * The coverage the reader chose, per session.
   *
   * The key is the session id, so a choice made for one session never
   * reaches another one: the sub-agent tasks of a session are its own.
   */
  const [coverage, setCoverage] = React.useState<Record<string, boolean>>({});
  /**
   * Whether the session list is complete.
   *
   * The list arrives in pages, and it is also the only place the lineage
   * lives. A count taken from a list that is still loading counts the
   * sub-agent tasks the first page named, and no more, so the export would
   * leave out the rest without saying so.
   */
  const [sessionListComplete, setSessionListComplete] = React.useState(false);
  const [format, setFormat] = React.useState<ExportFormat>('markdown');
  const [mode, setMode] = React.useState<ProjectionMode>('readable');

  /**
   * Counts the sub-agent tasks the session has, with the same walk the
   * export itself uses, so the number the dialog shows and the number the
   * document carries are one.
   *
   * The count is only made from a complete session list. The list arrives
   * in pages, and a count taken from a partial list would name a number the
   * document does not carry. The count itself takes a moment: the walk reads
   * the records, because a child the session list does not name is still a
   * child the export covers.
   */
  const countDescendants = React.useCallback(async (next: SessionExportTarget) => {
    const { hasLoaded } = useGlobalSessionsStore.getState();
    if (!hasLoaded) {
      // The list is not the whole list yet. The count would be a guess, so
      // the dialog says the coverage is unknown instead of naming a number
      // that is wrong.
      setSessionListComplete(false);
      setDescendantCount(0);
      return;
    }
    // The count is being made, so the coverage is unknown until it is.
    setSessionListComplete(false);
    const count = await countSubagents(next);
    setSessionListComplete(true);
    setDescendantCount(count);
    // The coverage is the reader's own choice, and the count does not make
    // it: a session the reader turned the sub-agent tasks off for keeps
    // that choice. A session with no sub-agent tasks shows no checkbox, so
    // there is nothing to turn off, and the export still carries a child the
    // list has not named yet.
  }, [countSubagents]);

  const openDialog = React.useCallback((next: SessionExportTarget) => {
    setTarget(next);
    // The choice the reader already made for this session. A session they
    // have not decided about yet covers the lineage.
    setIncludeSubagents(coverage[next.sessionID] ?? true);
    void countDescendants(next);
  }, [countDescendants, coverage]);

  /**
   * Records the coverage the reader picked, for the session the dialog is
   * open for.
   */
  const handleCoverageChange = React.useCallback((include: boolean) => {
    if (target) {
      setCoverage((previous) => ({ ...previous, [target.sessionID]: include }));
    }
    setIncludeSubagents(include);
  }, [target]);

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
      sessionListComplete={sessionListComplete}
      includeSubagents={includeSubagents}
      onIncludeSubagentsChange={handleCoverageChange}
      onConfirm={handleConfirm}
      onRetryCount={target ? () => { void countDescendants(target); } : undefined}
    />
  ), [countDescendants, descendantCount, format, handleConfirm, handleCoverageChange, includeSubagents, mode, sessionListComplete, target]);

  return { dialog, target, openDialog };
};
