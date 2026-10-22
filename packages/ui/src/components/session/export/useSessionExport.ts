/**
 * Writing a session export, from the Header and from the Sidebar.
 *
 * Both places open the same dialog and call the same function, so the
 * document they produce is the same document: the same sessions, the same
 * sub-agent transcripts, the same ordering. The Header and the Sidebar
 * differ only in where the export starts from.
 *
 * The export loads the session's own history and the history of every
 * descendant the session list names, then hands them to the one pipeline. A
 * descendant that cannot be loaded is reported in the document and in a
 * toast; it never fails the export.
 */

import * as React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import {
  buildExportFilename,
  downloadAsText,
  getExportRevealLabelKey,
  renderExportDocument,
  revealExportedMarkdown,
  saveAsMarkdownDesktop,
  type ExportFormat,
  type SessionMessageRecord,
} from '@/lib/exportSession';
import { countSubagentTasks, readExportSessions, type ExportSession } from '@/lib/export/collect';
import { buildExport } from '@/lib/export/pipeline';
import { useSessionExportDialog, type ExportChoice, type UseSessionExportDialog } from './useSessionExportDialog';

const MIME_TYPES = new Map<ExportFormat, string>([
  ['markdown', 'text/markdown'],
  ['html', 'text/html'],
  ['json', 'application/json'],
]);

const EXTENSIONS = new Map<ExportFormat, string>([
  ['markdown', 'md'],
  ['html', 'html'],
  ['json', 'json'],
]);

export type SessionExportTarget = {
  /** The session to export. */
  sessionID: string;
  /** The session's title, for the file name and the document's heading. */
  title: string | null | undefined;
  /** The directory the session runs in. */
  directory: string;
};

type UseSessionExport = UseSessionExportDialog & {
  /** Opens the export dialog for a session. */
  openExport: (target: SessionExportTarget) => void;
};

/**
 * The export's own state: the dialog, and the writing of the file.
 */
export const useSessionExport = (): UseSessionExport => {
  const { t } = useI18n();
  const loadRecords = useSessionMessageRecordsForExport();

  /**
   * Counts the sub-agent tasks a session has, with the walk the export
   * itself makes.
   *
   * The count and the document come from one walk, so the number the dialog
   * shows is the number the document carries: the sessions the list names
   * below the root, and the children the records name. A child the list does
   * not name is a child the export covers, so it belongs in the count too.
   */
  const countSubagents = React.useCallback(async (target: SessionExportTarget): Promise<number> => {
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    const allSessions = readExportSessions([...activeSessions, ...archivedSessions]);
    const root = allSessions.find((session) => session.id === target.sessionID);

    return countSubagentTasks({
      root: {
        id: target.sessionID,
        title: target.title ?? 'Session',
        parentID: root?.parentID,
        agent: root?.agent,
        createdAt: root?.createdAt,
      },
      sessions: allSessions,
      load: async (sessionID) => loadRecords({ sessionID, directory: target.directory }).catch(() => null),
    });
  }, [loadRecords]);

  const writeExport = React.useCallback(async (
    target: SessionExportTarget,
    choice: ExportChoice,
  ): Promise<void> => {
    // The session list is read when the export runs, not while the row
    // renders: a sidebar holds a row per session, and every one of them
    // would otherwise follow the list.
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    const allSessions = readExportSessions([...activeSessions, ...archivedSessions]);
    const root = allSessions.find((session) => session.id === target.sessionID);

    // The root session the export starts from. The lineage below it is the
    // collector's business: it walks the session list and loads what the
    // user asked to be covered.
    const rootSession: ExportSession = {
      id: target.sessionID,
      title: target.title ?? 'Session',
      parentID: root?.parentID,
      agent: root?.agent,
      createdAt: root?.createdAt,
    };

    const load = async (sessionID: string): Promise<SessionMessageRecord[] | null> => {
      if (sessionID === target.sessionID) {
        return loadRecords({ sessionID: target.sessionID, directory: target.directory }).catch(() => null);
      }
      return loadRecords({ sessionID, directory: target.directory }).catch(() => null);
    };

    const rootRecords = await load(target.sessionID);
    if (!rootRecords) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    if (rootRecords.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    // The pipeline loads the descendants in waves and joins a call to the
    // child session it started. The Header and the Sidebar hand it the same
    // sessions, so both produce the same document.
    const result = await buildExport({
      root: rootSession,
      // The whole list, so the collector walks the lineage itself. The
      // coverage choice reaches the collector: a user who does not want the
      // sub-agent transcripts gets a document without them, and without a
      // notice that they were left out.
      sessions: allSessions,
      load: async (sessionID) => {
        if (sessionID === target.sessionID) return rootRecords;
        return load(sessionID);
      },
      includeSubagents: choice.includeSubagents,
    }, choice.mode);

    const document = renderExportDocument(result, choice.format, choice.mode, target.title);
    const skipped = result.timeline.findings.filter((finding) => finding.kind === 'missing-session').length;

    const filename = buildExportFilename(target.title, EXTENSIONS.get(choice.format) ?? 'md');
    const savedPath = await saveAsMarkdownDesktop(document, filename, choice.format);
    if (!savedPath) {
      downloadAsText(document, filename, MIME_TYPES.get(choice.format) ?? 'text/plain');
    }

    toast.success(t('sessions.sidebar.session.export.success'), savedPath ? {
      action: {
        label: t(getExportRevealLabelKey()),
        onClick: () => {
          void revealExportedMarkdown(savedPath).then((revealed) => {
            if (!revealed) {
              toast.error(t('sessions.sidebar.session.export.failedRevealPath'));
            }
          });
        },
      },
    } : undefined);

    // The document names every sub-agent it could not load, and says so
    // once. The toast says the same thing to the person who asked.
    if (skipped > 0) {
      toast.warning(skipped === 1
        ? t('sessions.sidebar.session.export.skippedSubtaskSingle', { count: skipped })
        : t('sessions.sidebar.session.export.skippedSubtaskMany', { count: skipped }));
    }
  }, [loadRecords, t]);

  const dialog = useSessionExportDialog((target, choice) => {
    void writeExport(target, choice);
  }, countSubagents);

  return { ...dialog, openExport: dialog.openDialog };
};
