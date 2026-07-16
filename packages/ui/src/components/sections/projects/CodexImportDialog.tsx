import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { CodexImportPreview, CodexImportProject, CodexImportResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';

interface CodexImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportSelection {
  projectPaths: Set<string>;
  threadIds: Set<string>;
}

export const CodexImportDialog: React.FC<CodexImportDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const [preview, setPreview] = React.useState<CodexImportPreview | null>(null);
  const [selection, setSelection] = React.useState<ImportSelection>({ projectPaths: new Set(), threadIds: new Set() });
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CodexImportResult | null>(null);
  const previewRequestRef = React.useRef(0);

  const loadPreview = React.useCallback(async () => {
    if (!apis.imports) return;
    const requestId = ++previewRequestRef.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const next = await apis.imports.inspectCodex();
      if (previewRequestRef.current !== requestId) return;
      const availableProjects = next.projects.filter((project) => project.exists);
      setPreview(next);
      setSelection({
        projectPaths: new Set(availableProjects.map((project) => project.path)),
        threadIds: new Set(availableProjects.flatMap((project) => project.threadIds)),
      });
      setExpandedPaths(new Set());
    } catch (loadError) {
      if (previewRequestRef.current !== requestId) return;
      setPreview(null);
      setError(loadError instanceof Error ? loadError.message : t('settings.projects.codexImport.error.inspect'));
    } finally {
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  }, [apis.imports, t]);

  React.useEffect(() => {
    if (!open) {
      previewRequestRef.current += 1;
      return;
    }
    void loadPreview();
    return () => {
      previewRequestRef.current += 1;
    };
  }, [loadPreview, open]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (importing && !nextOpen) return;
    onOpenChange(nextOpen);
  }, [importing, onOpenChange]);

  const toggleProject = React.useCallback((project: CodexImportProject, checked: boolean) => {
    setSelection((current) => {
      const projectPaths = new Set(current.projectPaths);
      const threadIds = new Set(current.threadIds);
      if (checked) {
        projectPaths.add(project.path);
        project.threadIds.forEach((threadId) => threadIds.add(threadId));
      } else {
        projectPaths.delete(project.path);
        project.threadIds.forEach((threadId) => threadIds.delete(threadId));
      }
      return { projectPaths, threadIds };
    });
  }, []);

  const toggleThread = React.useCallback((project: CodexImportProject, threadId: string, checked: boolean) => {
    setSelection((current) => {
      const projectPaths = new Set(current.projectPaths);
      const threadIds = new Set(current.threadIds);
      if (checked) {
        projectPaths.add(project.path);
        threadIds.add(threadId);
      } else {
        threadIds.delete(threadId);
        if (!project.threadIds.some((id) => threadIds.has(id))) projectPaths.delete(project.path);
      }
      return { projectPaths, threadIds };
    });
  }, []);

  const toggleExpanded = React.useCallback((projectPath: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  const handleImport = React.useCallback(async () => {
    if (!apis.imports || !preview || selection.projectPaths.size === 0) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const nextResult = await apis.imports.applyCodex({
        projectPaths: Array.from(selection.projectPaths),
        threadIds: Array.from(selection.threadIds),
      });
      setResult(nextResult);
      const settings = await apis.settings.load();
      useProjectsStore.getState().synchronizeFromSettings(settings.settings);
      const imported = nextResult.results.filter((item) => item.status === 'imported').length;
      const skipped = nextResult.results.filter((item) => item.status === 'skipped').length;
      const failed = nextResult.results.filter((item) => item.status === 'failed').length;
      if (failed > 0) {
        toast.error(t('settings.projects.codexImport.toast.partial', { imported, skipped, failed }));
      } else {
        toast.success(t('settings.projects.codexImport.toast.complete', { imported, skipped }));
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t('settings.projects.codexImport.error.apply'));
    } finally {
      setImporting(false);
    }
  }, [apis.imports, apis.settings, preview, selection, t]);

  const importedCount = result?.results.filter((item) => item.status === 'imported').length ?? 0;
  const skippedCount = result?.results.filter((item) => item.status === 'skipped').length ?? 0;
  const failedItems = result?.results.filter((item) => item.status === 'failed') ?? [];
  const availableProjects = preview?.projects.filter((project) => project.exists) ?? [];
  const threadById = new Map((preview?.threads ?? []).map((thread) => [thread.id, thread]));

  const selectAll = () => {
    setSelection({
      projectPaths: new Set(availableProjects.map((project) => project.path)),
      threadIds: new Set(availableProjects.flatMap((project) => project.threadIds)),
    });
  };

  const selectNone = () => {
    setSelection({ projectPaths: new Set(), threadIds: new Set() });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden" showCloseButton={!importing}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('settings.projects.codexImport.title')}</DialogTitle>
          <DialogDescription>{t('settings.projects.codexImport.description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
            <Icon name="loader-4" className="size-4 animate-spin" />
            <span className="typography-ui-label">{t('settings.projects.codexImport.loading')}</span>
          </div>
        ) : error ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <Icon name="error-warning" className="size-5 text-status-error" />
            <p className="max-w-lg typography-ui-label text-muted-foreground break-words">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadPreview()}>
              <Icon name="refresh" className="size-4" />
              {t('settings.projects.codexImport.actions.retry')}
            </Button>
          </div>
        ) : preview ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 typography-meta text-muted-foreground">
              <span>{t('settings.projects.codexImport.config.model', { model: preview.config.model || t('settings.projects.codexImport.config.unset') })}</span>
              <span>{t('settings.projects.codexImport.config.provider', { provider: preview.config.modelProvider || t('settings.projects.codexImport.config.unset') })}</span>
            </div>

            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">{t('settings.projects.codexImport.projects.title')}</h3>
              <div className="flex items-center gap-1">
                <Button variant="chip" size="xs" onClick={selectAll}>
                  {t('settings.projects.codexImport.actions.selectAll')}
                </Button>
                <Button variant="chip" size="xs" onClick={selectNone}>
                  {t('settings.projects.codexImport.actions.selectNone')}
                </Button>
              </div>
            </div>

            {preview.projects.length === 0 ? (
              <p className="px-1 py-6 typography-ui-label text-muted-foreground">{t('settings.projects.codexImport.empty')}</p>
            ) : (
              <div className="divide-y border-y">
                {preview.projects.map((project) => {
                  const selectedThreadCount = project.threadIds.filter((threadId) => selection.threadIds.has(threadId)).length;
                  const allThreadsSelected = project.threadIds.length === 0
                    ? selection.projectPaths.has(project.path)
                    : selectedThreadCount === project.threadIds.length;
                  const partiallySelected = selectedThreadCount > 0 && !allThreadsSelected;
                  const expanded = expandedPaths.has(project.path);
                  const threads = project.threadIds.map((threadId) => threadById.get(threadId)).filter(Boolean);

                  return (
                    <div key={project.path}>
                      <div className="flex items-start gap-3 px-2 py-2.5">
                        <Checkbox
                          checked={allThreadsSelected}
                          indeterminate={partiallySelected}
                          onChange={(checked) => toggleProject(project, checked)}
                          disabled={!project.exists || importing}
                          ariaLabel={project.path}
                          className="mt-0.5"
                        />
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!project.exists || importing || threads.length === 0}
                          aria-expanded={threads.length > 0 ? expanded : undefined}
                          onClick={() => toggleExpanded(project.path)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate typography-ui-label text-foreground">{project.path}</span>
                            <span className="mt-0.5 block typography-meta text-muted-foreground">
                              {project.exists
                                ? t('settings.projects.codexImport.projects.conversations', {
                                    count: partiallySelected ? `${selectedThreadCount}/${project.threadIds.length}` : project.threadCount,
                                  })
                                : t('settings.projects.codexImport.projects.missing')}
                            </span>
                          </span>
                          {threads.length > 0 ? (
                            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          ) : null}
                        </button>
                      </div>

                      {expanded ? (
                        <div className="border-t bg-[var(--surface-subtle)]">
                          {threads.map((thread) => thread ? (
                            <div key={thread.id} className="flex items-start gap-3 py-2 pl-9 pr-2">
                              <Checkbox
                                checked={selection.threadIds.has(thread.id)}
                                onChange={(checked) => toggleThread(project, thread.id, checked)}
                                disabled={importing}
                                ariaLabel={thread.title}
                                className="mt-0.5"
                              />
                              <button
                                type="button"
                                className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={importing}
                                onClick={() => toggleThread(project, thread.id, !selection.threadIds.has(thread.id))}
                              >
                                <span className="block truncate typography-ui-label text-foreground">{thread.title}</span>
                                <span className="mt-0.5 flex items-center gap-1.5 typography-meta text-muted-foreground">
                                  {thread.updatedAt ? <span>{formatSessionCompactDateLabel(thread.updatedAt * 1000)}</span> : null}
                                  {thread.archived ? <span>{t('sessions.sidebar.grouping.archived')}</span> : null}
                                </span>
                              </button>
                            </div>
                          ) : null)}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {result ? (
              <div className="mt-4 border-t pt-3">
                <p className="typography-ui-label text-foreground">
                  {t('settings.projects.codexImport.result.summary', {
                    imported: importedCount,
                    skipped: skippedCount,
                    failed: failedItems.length,
                  })}
                </p>
                {failedItems.length > 0 ? (
                  <div className="mt-2 space-y-1 typography-meta text-status-error">
                    {failedItems.map((item) => <p key={item.threadId} className="break-words">{item.threadId}: {item.error}</p>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="shrink-0">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleImport()} disabled={!preview || selection.projectPaths.size === 0 || loading || importing}>
            {importing ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="download" className="size-4" />}
            {importing ? t('settings.projects.codexImport.actions.importing') : t('settings.common.actions.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
