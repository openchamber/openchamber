import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, getExportRevealLabelKey, revealExportedMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import type { SessionNode } from '../types';
import { buildActiveSessionTreeFromCache } from './sessionSubtreeActions';

type ExportTarget = { session: Session; directory: string | null; tree: SessionNode };

const countDescendants = (root: SessionNode): number => root.children.reduce(
  (count, child) => count + 1 + countDescendants(child),
  0,
);

/**
 * Export as Markdown for a session menu. A session with subsessions asks
 * first whether to include them; the dialog is the host's to render, outside
 * the menu, which unmounts when it closes.
 */
export function useSessionMarkdownExport(): {
  /** `knownTree`: the subsessions the surface already shows; the cache fills in the rest. */
  requestExport: (session: Session, directory: string | null, knownTree?: SessionNode | null) => void;
  dialog: React.ReactNode;
} {
  const { t } = useI18n();
  const loadExportRecords = useSessionMessageRecordsForExport();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [includeSubtasks, setIncludeSubtasks] = React.useState(true);
  // Kept after the dialog closes, so its closing animation shows the same text.
  const [target, setTarget] = React.useState<ExportTarget | null>(null);

  const collectChildExports = React.useCallback(async (
    directory: string,
    children: SessionNode[],
  ): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
    const results: ChildSessionExport[] = [];
    let skipped = 0;
    for (const child of children) {
      try {
        const childRecords = await loadExportRecords({ directory, sessionID: child.session.id });
        if (!childRecords) throw new Error('Session runtime changed during export');
        const childTitle = child.session.title || t('sessions.sidebar.session.export.untitledSubagent');
        // SAFETY: OpenCode session payloads may carry the optional agent label used by exports.
        const childAgent = (child.session as Session & { agent?: string }).agent;
        const grandChildren = await collectChildExports(directory, child.children);
        skipped += grandChildren.skipped;
        results.push({
          title: childTitle,
          agent: childAgent,
          records: childRecords,
          children: grandChildren.children,
        });
      } catch {
        skipped += countDescendants(child) + 1;
      }
    }
    return { children: results, skipped };
  }, [loadExportRecords, t]);

  const showSkippedSubtasksWarning = React.useCallback((count: number) => {
    if (count <= 0) return;
    toast.warning(count === 1
      ? t('sessions.sidebar.session.export.skippedSubtaskSingle', { count })
      : t('sessions.sidebar.session.export.skippedSubtaskMany', { count }));
  }, [t]);

  const runExport = React.useCallback(async ({ session, directory, tree }: ExportTarget, withSubtasks: boolean) => {
    if (!directory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    const records = await loadExportRecords({ directory, sessionID: session.id }).catch(() => null);
    if (!records) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    if (records.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    let childExports: ChildSessionExport[] | undefined;
    let skippedSubtaskCount = 0;
    if (withSubtasks && tree.children.length > 0) {
      const collected = await collectChildExports(directory, tree.children);
      childExports = collected.children;
      skippedSubtaskCount = collected.skipped;
    }

    const markdown = formatSessionAsMarkdown(records, session.title ?? null, childExports);
    const filename = buildExportFilename(session.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);

    if (savedPath) {
      toast.success(t('sessions.sidebar.session.export.success'), {
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
      });
      showSkippedSubtasksWarning(skippedSubtaskCount);
      return;
    }

    downloadAsMarkdown(markdown, filename);
    toast.success(t('sessions.sidebar.session.export.success'));
    showSkippedSubtasksWarning(skippedSubtaskCount);
  }, [collectChildExports, loadExportRecords, showSkippedSubtasksWarning, t]);

  const requestExport = React.useCallback((session: Session, directory: string | null, knownTree?: SessionNode | null) => {
    const tree = knownTree && knownTree.children.length > 0 ? knownTree : buildActiveSessionTreeFromCache(session);
    if (tree.children.length > 0) {
      setTarget({ session, directory, tree });
      setIncludeSubtasks(true);
      setDialogOpen(true);
      return;
    }
    void runExport({ session, directory, tree }, false);
  }, [runExport]);

  const descendantCount = target ? countDescendants(target.tree) : 0;
  const dialog = (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.session.export.dialog.title')}</DialogTitle>
          <DialogDescription>
            {descendantCount === 1
              ? t('sessions.sidebar.session.export.dialog.descriptionSingle', { count: descendantCount })
              : t('sessions.sidebar.session.export.dialog.descriptionMany', { count: descendantCount })}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
          <input
            type="checkbox"
            checked={includeSubtasks}
            onChange={(e) => setIncludeSubtasks(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          {t('sessions.sidebar.session.export.dialog.includeSubtasks')}
        </label>
        <DialogFooter>
          <Button type="button" onClick={() => setDialogOpen(false)} variant="outline" size="sm">
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setDialogOpen(false);
              if (target) void runExport(target, includeSubtasks);
            }}
            size="sm"
          >
            {t('sessions.sidebar.session.export.dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { requestExport, dialog };
}
