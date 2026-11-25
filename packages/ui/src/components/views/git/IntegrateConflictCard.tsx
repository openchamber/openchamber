import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { abortIntegrate, continueIntegrate, listIntegrateConflicts, type IntegrateConflict } from '@/lib/git/integrateWorktreeCommits';
import { loadMagicPrompts } from '@/lib/magicPrompts';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { formatDirectoryName } from '@/lib/utils';
import { recordIntegrateCheckout } from '@/lib/worktrees/worktreeManager';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const IntegrateConflictCard: React.FC<{
  conflict: IntegrateConflict;
  directory: string;
  onActed: () => Promise<void>;
  onSettled: () => void;
}> = ({ conflict, directory, onActed, onSettled }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setPendingInputText = useInputStore((s) => s.setPendingInputText);
  const setPendingSyntheticParts = useInputStore((s) => s.setPendingSyntheticParts);
  const [acting, setActing] = React.useState(false);

  const projects = useProjectsStore((s) => s.projects);
  const worktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
  const projectOfRepository = React.useMemo(
    () => projects.find((project) => normalizePath(project.path) === normalizePath(conflict.state.repoRoot))
      ?? resolveProjectForSessionDirectory(projects, worktreesByProject, directory)
      ?? resolveProjectForDirectory(projects, conflict.state.repoRoot),
    [projects, conflict.state.repoRoot, directory, worktreesByProject],
  );

  const buildConflictContext = React.useCallback(async (payload: IntegrateConflict) => {
    const prompts = await loadMagicPrompts(payload.state.repoRoot);
    const visibleText = prompts.render('git.integrate.cherrypick.resolve.visible', {
      current_commit: payload.state.currentCommit,
      target_branch: payload.state.targetBranch,
    });
    const instructionsText = prompts.render('git.integrate.cherrypick.resolve.instructions', {
      repo_root: payload.state.repoRoot,
      temp_worktree_path: payload.state.tempWorktreePath,
      source_branch: payload.state.sourceBranch,
      target_branch: payload.state.targetBranch,
      current_commit: payload.state.currentCommit,
    });
    const payloadText = `Cherry-pick conflict context (JSON)\n${JSON.stringify({
      repoRoot: payload.state.repoRoot,
      tempWorktreePath: payload.state.tempWorktreePath,
      sourceBranch: payload.state.sourceBranch,
      targetBranch: payload.state.targetBranch,
      currentCommit: payload.state.currentCommit,
      remainingCommits: payload.state.remainingCommits,
      statusPorcelain: payload.details.statusPorcelain,
      unmergedFiles: payload.details.unmergedFiles,
      currentPatchMeta: payload.details.currentPatchMeta,
      currentPatch: payload.details.currentPatch,
      diff: payload.details.diff,
    }, null, 2)}`;

    return { visibleText, instructionsText, payloadText };
  }, []);

  const handleResolveWithAi = React.useCallback(async (
    shown: IntegrateConflict,
    useNewSession: boolean
  ) => {
    const isCurrent = captureRuntimeInstance();
    let payload: IntegrateConflict;
    let context: Awaited<ReturnType<typeof buildConflictContext>>;
    try {
      const current = (await listIntegrateConflicts(shown.state.repoRoot))
        .find((entry) => entry.state.tempWorktreePath === shown.state.tempWorktreePath);
      if (!isCurrent()) return;
      if (current?.state.revision !== shown.state.revision) {
        toast.message(t(current ? 'gitView.integrate.conflict.changed' : 'gitView.integrate.conflict.gone'));
        await onActed();
        return;
      }
      payload = current;
      context = await buildConflictContext(payload);
    } catch (error) {
      if (!isCurrent()) return;
      toast.error(t('magicPrompts.toast.loadFailed'), { description: error instanceof Error ? error.message : undefined });
      return;
    }

    if (!isCurrent()) return;

    if (useNewSession) {
      if (projectOfRepository) recordIntegrateCheckout(projectOfRepository, payload.state.repoRoot, payload.state.tempWorktreePath);
      openNewSessionDraft({
        directoryOverride: payload.state.tempWorktreePath,
        selectedProjectId: projectOfRepository?.id,
        preserveDirectoryOverride: true,
        initialPrompt: context.visibleText,
        syntheticParts: [
          { text: context.instructionsText, synthetic: true },
          { text: context.payloadText, synthetic: true },
        ],
      });
      return;
    }

    if (!currentSessionId) {
      toast.error(t('gitView.integrate.noActiveSession'), { description: t('gitView.integrate.noActiveSessionDescription') });
      return;
    }

    setPendingInputText(context.visibleText, 'replace');
    setPendingSyntheticParts([
      { text: context.instructionsText, synthetic: true },
      { text: context.payloadText, synthetic: true },
    ]);
  }, [currentSessionId, buildConflictContext, onActed, projectOfRepository, openNewSessionDraft, setPendingInputText, setPendingSyntheticParts, t]);

  const act = async (action: 'abort' | 'continue') => {
    const isCurrent = captureRuntimeInstance();
    setActing(true);
    try {
      const result = await (action === 'abort' ? abortIntegrate : continueIntegrate)(conflict.state);
      if (!isCurrent()) return;
      const kept = result.kind === 'kept' || (result.kind === 'success' && result.kept === true);
      if (result.kind === 'busy') {
        toast.error(t('gitView.integrate.conflict.busy'));
      } else if (result.kind === 'gone') {
        toast.message(t('gitView.integrate.conflict.gone'));
      } else if (result.kind === 'conflict') {
        if (result.reason === 'changed') toast.message(t('gitView.integrate.conflict.changed'));
        if (result.reason === 'sessionsHeld') toast.message(t('gitView.integrate.conflict.sessionsHeld'));
      } else {
        if (result.kind !== 'success') toast.message(t('gitView.integrate.cherryPickAbortedToast'));
        else toast.success(t('gitView.integrate.cherryPickFinishedToast'));
        if (kept) toast.error(t('gitView.integrate.conflict.kept'));
        if (result.kind !== 'noop' && result.sessionsMoved && result.sessionsDirectory) {
          toast.info(t('sessions.sidebar.session.restore.relocatedTitle'), {
            description: t('sessions.sidebar.session.restore.relocatedDescription', { project: formatDirectoryName(result.sessionsDirectory) }),
          });
        }
        onSettled();
      }
    } catch (error) {
      if (!isCurrent()) return;
      toast.error(t('gitView.integrate.cherryPickContinueFailedToast'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setActing(false);
      if (isCurrent()) await onActed();
    }
  };

  return (
    <div className="rounded-md oc-tile p-3 space-y-2">
      <div className="typography-micro text-muted-foreground truncate">
        {conflict.state.sourceBranch} → {conflict.state.targetBranch}
      </div>
      {conflict.state.finish ? (
        <div className="typography-meta text-foreground break-words">{t('gitView.integrate.conflict.sessionsHeld')}</div>
      ) : null}
      {conflict.message ? (
        <div className="typography-meta text-foreground break-words">{conflict.message}</div>
      ) : null}
      {!conflict.state.finish && conflict.details.unmergedFiles.length > 0 ? (
        <>
          <div className="typography-meta text-foreground">
            {t('gitView.integrate.conflictsInFiles', { count: conflict.details.unmergedFiles.length })}
          </div>
          <div className="typography-micro text-muted-foreground">
            {t('gitView.integrate.currentCommit')}: <span className="font-mono">{conflict.state.currentCommit.slice(0, 7)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {conflict.details.unmergedFiles.slice(0, 6).map((file) => (
              <span key={file} className="font-mono text-xs px-2 py-0.5 rounded oc-tile-inset text-muted-foreground">
                {file}
              </span>
            ))}
            {conflict.details.unmergedFiles.length > 6 && (
              <span className="text-xs text-muted-foreground">{t('gitView.integrate.moreFiles', { count: conflict.details.unmergedFiles.length - 6 })}</span>
            )}
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {conflict.state.finish ? null : <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.abortOperation')}>
          <Button size="sm" variant="ghost" className="typography-meta" disabled={acting} onClick={() => void act('abort')}>
            {t('gitView.operation.abort')}
          </Button>
        </ButtonTooltip>}
        {!conflict.state.finish && conflict.details.unmergedFiles.length > 0 ? (
          <>
            <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.resolveInCurrentSession')}>
              <Button
                size="sm"
                variant="secondary"
                className="typography-meta gap-1"
                disabled={!currentSessionId}
                onClick={() => void handleResolveWithAi(conflict, false)}
              >
                <Icon name="sparkling" className="size-3.5" />
                {t('gitView.integrate.currentSession')}
              </Button>
            </ButtonTooltip>
            <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.resolveInNewSession')}>
              <Button
                size="sm"
                variant="secondary"
                className="typography-meta gap-1"
                onClick={() => void handleResolveWithAi(conflict, true)}
              >
                <Icon name="sparkling" className="size-3.5" />
                {t('gitView.integrate.newSession')}
              </Button>
            </ButtonTooltip>
          </>
        ) : null}
        <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.continueOperation')}>
          <Button size="sm" className="typography-meta" disabled={acting} onClick={() => void act('continue')}>
            {t('gitView.operation.continue')}
          </Button>
        </ButtonTooltip>
      </div>
    </div>
  );
};
