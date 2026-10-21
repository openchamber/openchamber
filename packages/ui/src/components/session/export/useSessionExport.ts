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
import { listDescendantSessions, readExportSessions, type ExportSession } from '@/lib/export/collect';
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

    // The descendants the export covers: the whole lineage below the root.
    // The dialog counted the same sessions with the same walk, so the number
    // the user was shown and the number the document carries are one.
    const rootSession: ExportSession = {
      id: target.sessionID,
      title: target.title ?? 'Session',
      parentID: root?.parentID,
      agent: root?.agent,
      createdAt: root?.createdAt,
    };
    // A user who does not want the sub-agent transcripts gets a document
    // without them, not a document that says they are missing.
    const descendants = choice.includeSubagents
      ? listDescendantSessions(rootSession, allSessions)
      : [];

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
      sessions: [rootSession, ...descendants],
      load: async (sessionID) => {
        if (sessionID === target.sessionID) return rootRecords;
        return load(sessionID);
      },
      // The sub-agent transcripts the user left out are excluded on purpose.
      // The export says so, rather than reporting them as missing.
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
  });

  return { ...dialog, openExport: dialog.openDialog };
};
