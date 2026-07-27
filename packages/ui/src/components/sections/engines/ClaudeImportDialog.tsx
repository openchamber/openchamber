import React from 'react';
import { toast } from '@/components/ui';
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
import { useI18n } from '@/lib/i18n';
import {
  HarnessClientError,
  importClaudeSessions,
  listClaudeImportCandidates,
  type ClaudeImportProjectCandidate,
  type ClaudeImportSessionCandidate,
} from '@/lib/harness/client';
import { refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSelectionStore } from '@/sync/selection-store';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';

type SelectedKey = string;

const sessionKey = (foreignSessionId: string): SelectedKey => foreignSessionId;

const projectLabel = (project: ClaudeImportProjectCandidate): string => {
  if (project.directory) {
    const parts = project.directory.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || project.directory;
  }
  return project.projectKey || '—';
};

const selectableSessions = (project: ClaudeImportProjectCandidate): ClaudeImportSessionCandidate[] =>
  project.sessions.filter((session) => !session.alreadyImported && !session.directoryMissing && session.directory);

export type ClaudeImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const ClaudeImportDialog: React.FC<ClaudeImportDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [projects, setProjects] = React.useState<ClaudeImportProjectCandidate[]>([]);
  const [selected, setSelected] = React.useState<Set<SelectedKey>>(() => new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());

  const loadCandidates = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await listClaudeImportCandidates();
      setProjects(payload.projects);
      const nextExpanded = new Set<string>();
      const nextSelected = new Set<SelectedKey>();
      for (const project of payload.projects) {
        nextExpanded.add(project.projectKey);
        for (const session of selectableSessions(project)) {
          nextSelected.add(sessionKey(session.foreignSessionId));
        }
      }
      setExpanded(nextExpanded);
      setSelected(nextSelected);
    } catch (err) {
      const message = err instanceof HarnessClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('settings.engines.claudeCode.import.error.load');
      setError(message);
      setProjects([]);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    if (!open) return;
    void loadCandidates();
  }, [open, loadCandidates]);

  const allSelectable = React.useMemo(
    () => projects.flatMap((project) => selectableSessions(project)),
    [projects],
  );

  const selectedCount = selected.size;
  const allSelected = allSelectable.length > 0 && allSelectable.every((session) => selected.has(sessionKey(session.foreignSessionId)));

  const toggleSession = React.useCallback((session: ClaudeImportSessionCandidate, enabled: boolean) => {
    if (session.alreadyImported || session.directoryMissing || !session.directory) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const key = sessionKey(session.foreignSessionId);
      if (enabled) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleProject = React.useCallback((project: ClaudeImportProjectCandidate, enabled: boolean) => {
    const sessions = selectableSessions(project);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const session of sessions) {
        const key = sessionKey(session.foreignSessionId);
        if (enabled) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = React.useCallback((enabled: boolean) => {
    if (!enabled) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(allSelectable.map((session) => sessionKey(session.foreignSessionId))));
  }, [allSelectable]);

  const handleImport = React.useCallback(async () => {
    if (selectedCount === 0 || importing) return;
    setImporting(true);
    setError(null);

    const requests = [];
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!selected.has(sessionKey(session.foreignSessionId))) continue;
        if (!session.directory) continue;
        requests.push({
          foreignSessionId: session.foreignSessionId,
          directory: session.directory,
          title: session.title,
        });
      }
    }

    try {
      const result = await importClaudeSessions(requests);
      const importedRows = result.results.filter((row) => row.ok && row.status === 'imported' && row.sessionId);
      const previousActive = useProjectsStore.getState().activeProjectId;
      const directories = new Set<string>();

      for (const row of importedRows) {
        if (row.sessionId) {
          useSelectionStore.getState().saveSessionTarget(row.sessionId, {
            harnessId: 'claude-code',
            modelRef: 'sonnet',
          });
        }
        if (row.directory) {
          directories.add(row.directory);
        }
      }

      for (const directory of directories) {
        useProjectsStore.getState().addProject(directory);
      }
      if (previousActive && useProjectsStore.getState().projects.some((project) => project.id === previousActive)) {
        useProjectsStore.getState().setActiveProject(previousActive);
      }

      if (directories.size > 0) {
        await refreshGlobalSessionsForDirectories([...directories]);
      }

      if (result.summary.imported > 0) {
        toast.success(t('settings.engines.claudeCode.import.toast.success', {
          count: result.summary.imported,
        }));
      }
      if (result.summary.skipped > 0 && result.summary.imported === 0 && result.summary.failed === 0) {
        toast.success(t('settings.engines.claudeCode.import.toast.skippedOnly', {
          count: result.summary.skipped,
        }));
      }
      if (result.summary.failed > 0) {
        toast.error(t('settings.engines.claudeCode.import.toast.partialFail', {
          failed: result.summary.failed,
          imported: result.summary.imported,
        }));
      }
      if (result.summary.imported === 0 && result.summary.skipped === 0 && result.summary.failed === 0) {
        toast.error(t('settings.engines.claudeCode.import.toast.none'));
      }

      onOpenChange(false);
    } catch (err) {
      const message = err instanceof HarnessClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('settings.engines.claudeCode.import.error.import');
      setError(message);
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }, [importing, onOpenChange, projects, selected, selectedCount, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col gap-0 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('settings.engines.claudeCode.import.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.engines.claudeCode.import.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto py-3 space-y-3">
          {loading ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.claudeCode.import.dialog.loading')}</p>
          ) : error && projects.length === 0 ? (
            <p className="typography-ui text-status-error">{error}</p>
          ) : projects.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.claudeCode.import.dialog.empty')}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 typography-ui text-foreground">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && selectedCount > 0}
                    onChange={toggleSelectAll}
                    disabled={allSelectable.length === 0 || importing}
                    ariaLabel={t('settings.engines.claudeCode.import.dialog.selectAllAria')}
                  />
                  <span>{t('settings.engines.claudeCode.import.dialog.selectAll')}</span>
                </label>
                <span className={SETTINGS_HELPER_CLASS}>
                  {t('settings.engines.claudeCode.import.dialog.selectedCount', { count: selectedCount })}
                </span>
              </div>

              <ul className="space-y-2">
                {projects.map((project) => {
                  const selectable = selectableSessions(project);
                  const selectedInProject = selectable.filter((session) => selected.has(sessionKey(session.foreignSessionId))).length;
                  const projectChecked = selectable.length > 0 && selectedInProject === selectable.length;
                  const projectIndeterminate = selectedInProject > 0 && !projectChecked;
                  const isExpanded = expanded.has(project.projectKey);

                  return (
                    <li key={project.projectKey} className="space-y-1.5">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={projectChecked}
                          indeterminate={projectIndeterminate}
                          onChange={(enabled) => toggleProject(project, enabled)}
                          disabled={selectable.length === 0 || importing}
                          ariaLabel={t('settings.engines.claudeCode.import.dialog.projectAria', {
                            name: projectLabel(project),
                          })}
                        />
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(project.projectKey)) next.delete(project.projectKey);
                              else next.add(project.projectKey);
                              return next;
                            });
                          }}
                        >
                          <div className="typography-ui text-foreground truncate">{projectLabel(project)}</div>
                          <div className={cn(SETTINGS_HELPER_CLASS, 'truncate')}>
                            {project.directory || project.projectKey}
                            {project.directoryMissing
                              ? ` · ${t('settings.engines.claudeCode.import.dialog.directoryMissing')}`
                              : ''}
                            {` · ${t('settings.engines.claudeCode.import.dialog.sessionCount', {
                              count: project.sessionCount,
                            })}`}
                          </div>
                        </button>
                      </div>

                      {isExpanded ? (
                        <ul className="ml-6 space-y-1.5 border-l border-border pl-3">
                          {project.sessions.map((session) => {
                            const disabled = session.alreadyImported
                              || session.directoryMissing
                              || !session.directory
                              || importing;
                            return (
                              <li key={session.foreignSessionId} className="flex items-start gap-2">
                                <Checkbox
                                  checked={selected.has(sessionKey(session.foreignSessionId))}
                                  onChange={(enabled) => toggleSession(session, enabled)}
                                  disabled={disabled}
                                  ariaLabel={t('settings.engines.claudeCode.import.dialog.sessionAria', {
                                    title: session.title || session.foreignSessionId,
                                  })}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="typography-ui text-foreground truncate">
                                    {session.title || t('settings.engines.claudeCode.import.dialog.untitled')}
                                  </div>
                                  <div className={SETTINGS_HELPER_CLASS}>
                                    {session.alreadyImported
                                      ? t('settings.engines.claudeCode.import.dialog.alreadyImported')
                                      : session.directoryMissing
                                        ? t('settings.engines.claudeCode.import.dialog.directoryMissing')
                                        : session.foreignSessionId.slice(0, 8)}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {error && projects.length > 0 ? (
            <p className="typography-ui text-status-error">{error}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            {t('settings.engines.claudeCode.import.dialog.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={importing || selectedCount === 0 || loading}
            onClick={() => void handleImport()}
          >
            {importing
              ? t('settings.engines.claudeCode.import.dialog.importing')
              : t('settings.engines.claudeCode.import.dialog.import', { count: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
