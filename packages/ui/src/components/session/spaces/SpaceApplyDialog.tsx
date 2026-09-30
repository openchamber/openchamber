/**
 * The apply dialog of an isolated space (DESIGN.md, decisions 7 and 8, user journey step 6): what
 * the agent changed, as a branch named after the space or as uncommitted changes, and "delete the
 * space afterwards", on unless an agent still works there. Opened from the group's "⋯" menu, the
 * phone's sheet, the session header and the delete confirmation.
 *
 * Every path it shows came out of the space, so it is text in a monospace list and nothing else.
 * Mounted once by the main layout and the mobile app, behind the switch; never in VS Code
 * (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Radio } from '@/components/ui/radio';
import { toast } from '@/components/ui';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { applyRefusalOf, applySpace, branchNameOfSpace, closesChanges, useAgentWorkingInSpace, type SpaceApplyRefusal } from '@/lib/spaces/space-apply';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { previewSpaceApply, type SpaceApplyPreview, type SpaceReportedPaths } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { spaceFailureText } from './spaceFailureText';

type PreviewRead = { kind: 'reading' } | { kind: 'read'; preview: SpaceApplyPreview } | { kind: 'refused'; refusal: SpaceApplyRefusal };

// The units every file manager shows, whatever the language; only the number is localised.
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

const formatSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${number} ${SIZE_UNITS[unit]}`;
};

export const SpaceApplyDialog: React.FC = () => {
  const spaceId = useSpacesStore((state) => state.applyDialog);
  // Keyed by the space, so every opening starts with its own defaults and its own read.
  return spaceId ? <ApplyDialogFor key={spaceId} spaceId={spaceId} /> : null;
};

const ApplyDialogFor: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const name = useSpacesStore((state) => state.journey?.get(spaceId)?.name ?? '');
  const agentWorking = useAgentWorkingInSpace(spaceId);
  const [read, setRead] = React.useState<PreviewRead>({ kind: 'reading' });
  const [readCount, setReadCount] = React.useState(0);
  const [as, setAs] = React.useState<'branch' | 'changes'>('branch');
  const [branch, setBranch] = React.useState(() => branchNameOfSpace(name));
  // Off when an agent is still at work as the dialog opens: deleting would stop it mid-turn.
  const [removeAfterwards, setRemoveAfterwards] = React.useState(() => !agentWorking);
  const [applying, setApplying] = React.useState(false);
  const [refusal, setRefusal] = React.useState<SpaceApplyRefusal | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startFailure, setStartFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setRead({ kind: 'reading' });
    const readPreview = async () => {
      try {
        const preview = await previewSpaceApply(spaceId, controller.signal);
        if (!controller.signal.aborted) setRead({ kind: 'read', preview });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (!controller.signal.aborted) setRead({ kind: 'refused', refusal: applyRefusalOf(error, null) });
      }
    };
    void readPreview();
    return () => controller.abort();
  }, [spaceId, readCount]);

  const close = () => useSpacesStore.getState().closeApplyDialog();
  const preview = read.kind === 'read' ? read.preview : null;
  const changesClosed = preview?.changesRoute === 'closed' || (refusal !== null && closesChanges(refusal));
  const chosen = changesClosed ? 'branch' : as;
  const nothingChanged = preview !== null && preview.changedPaths === 0;
  const nothingNew = preview !== null && preview.lastApplied !== null && preview.newPaths === 0;
  const canApply = preview !== null && !applying && !nothingChanged
    && (chosen === 'branch' ? branch.trim().length > 0 : !nothingNew);

  const start = async () => {
    setStarting(true);
    setRefusal(null);
    setStartFailure(null);
    await runSpaceAction(spaceId, 'start');
    setStarting(false);
    // The start's own reason, which otherwise shows only on the group's status line.
    const after = useSpacesStore.getState().actions.get(spaceId);
    if (after?.kind === 'failed' && after.action === 'start') setStartFailure(spaceFailureText(t, after.failure));
    else setReadCount((count) => count + 1);
  };

  const apply = async () => {
    setApplying(true);
    setRefusal(null);
    const result = await applySpace(spaceId, chosen === 'branch'
      ? { as: 'branch', branch: branch.trim(), removeAfterwards }
      : { as: 'changes', removeAfterwards });
    setApplying(false);
    if (result.kind === 'overtaken') return;
    if (result.kind === 'refused') {
      setRefusal(result.refusal);
      return;
    }
    const { applied } = result.outcome;
    if (applied.status === 'applied' && 'branch' in applied) toast.success(t('spaces.apply.done.branch', { branch: applied.branch }));
    else if (applied.status === 'applied') {
      toast.success(applied.appliedPaths === 1 ? t('spaces.apply.done.changesSingle') : t('spaces.apply.done.changesPlural', { count: applied.appliedPaths }));
    }
    close();
  };

  const refusalText = (shown: SpaceApplyRefusal): string => {
    switch (shown.kind) {
      case 'changes_closed': return t('spaces.apply.refused.changesClosed');
      case 'part_thrown_away': return t('spaces.apply.refused.partThrownAway');
      case 'ignored_in_the_way': return t('spaces.apply.refused.ignoredInTheWay', { path: shown.path });
      case 'filtered_in_the_way': return t('spaces.apply.refused.filteredInTheWay');
      case 'undecided': return t('spaces.apply.refused.undecided');
      case 'partly_applied': return t('spaces.apply.refused.partlyApplied');
      case 'nothing_to_apply': return t('spaces.apply.refused.nothingNew');
      case 'too_large': return t('spaces.apply.refused.tooLarge');
      case 'name_not_allowed': return t('spaces.apply.refused.nameNotAllowed', { path: shown.path });
      case 'case_only_rename': return t('spaces.apply.refused.caseOnlyRename', { path: shown.path, other: shown.other });
      case 'branch_exists': return t('spaces.apply.branch.exists', { branch: shown.branch });
      case 'invalid_branch': return t('spaces.apply.branch.invalid');
      case 'not_running': return t('spaces.apply.refused.notRunning');
      case 'other': return spaceFailureText(t, shown.failure);
    }
  };

  const pathList = (label: string, reported: SpaceReportedPaths) => (
    <div className="space-y-1">
      <p className="typography-meta text-status-warning">{label}</p>
      <ul className="max-h-24 overflow-y-auto typography-meta text-muted-foreground">
        {reported.paths.map((path) => <li key={path} className="truncate font-mono">{path}</li>)}
      </ul>
      {reported.count > reported.paths.length ? <p className="typography-meta text-muted-foreground">{t('spaces.apply.morePaths', { count: reported.count - reported.paths.length })}</p> : null}
    </div>
  );

  // A stopped space whose network filter is gone never starts again (see "Repair").
  const gatekeeperGone = useSpacesStore((state) => state.journey?.get(spaceId)?.damage === 'gatekeeper_gone');
  const branchRefusal = refusal?.kind === 'branch_exists' || refusal?.kind === 'invalid_branch' ? refusal : null;
  const topRefusal = refusal && !branchRefusal ? refusal : read.kind === 'refused' ? read.refusal : null;

  const sinceLastApply = (() => {
    if (!preview || preview.lastApplied === null || preview.newPaths === null) return null;
    if (preview.newPaths === 0) return t('spaces.apply.changes.nothingSinceLast');
    return preview.newPaths === 1 ? t('spaces.apply.changes.sinceLastSingle') : t('spaces.apply.changes.sinceLastPlural', { count: preview.newPaths });
  })();

  const option = (value: 'branch' | 'changes', label: string, disabled: boolean) => (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <Radio checked={chosen === value} onChange={() => setAs(value)} disabled={disabled} ariaLabel={label} className="mt-0.5" />
      <span className="typography-ui-label text-foreground">{label}</span>
    </label>
  );

  const body = (
    <div className="space-y-4">
      {agentWorking ? <p className="typography-meta text-status-warning">{t('spaces.apply.agentWorking')}</p> : null}
      {topRefusal ? (
        <div className="space-y-2">
          <p className="typography-meta text-status-error">{topRefusal.kind === 'not_running' && gatekeeperGone ? t('spaces.failure.gatekeeperGone') : refusalText(topRefusal)}</p>
          {topRefusal.kind === 'part_thrown_away' ? pathList(t('spaces.apply.refused.partThrownAwayFiles'), topRefusal.stillThere) : null}
          {startFailure ? <p className="typography-meta text-status-error">{startFailure}</p> : null}
          {topRefusal.kind === 'not_running' && !gatekeeperGone ? (
            <Button variant="outline" size="xs" onClick={() => void start()} disabled={starting} className="gap-1.5">
              {starting ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('spaces.actions.start')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {read.kind === 'reading' ? (
        <p className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
          {t('spaces.apply.loading')}
        </p>
      ) : null}

      {preview ? (
        <>
          <div className="space-y-1">
            <p className="typography-ui-label text-foreground">
              {nothingChanged
                ? t('spaces.apply.summary.none')
                : preview.changedPaths === 1
                  ? t('spaces.apply.summary.single', { size: formatSize(preview.changedBytes) })
                  : t('spaces.apply.summary.plural', { count: preview.changedPaths, size: formatSize(preview.changedBytes) })}
            </p>
            {nothingChanged ? null : <p className="typography-meta text-muted-foreground">{t('spaces.apply.summary.diffHint')}</p>}
          </div>
          {preview.nestedRepositories.count > 0 ? pathList(t('spaces.apply.warning.nestedRepositories'), preview.nestedRepositories) : null}
          {preview.unmerged.count > 0 ? pathList(t('spaces.apply.warning.unmerged'), preview.unmerged) : null}

          {nothingChanged ? null : (
            <div className="space-y-2">
              {option('branch', t('spaces.apply.as.branch'), false)}
              {chosen === 'branch' ? (
                <div className="space-y-1 pl-6">
                  <Input
                    value={branch}
                    onChange={(event) => { setBranch(event.target.value); if (branchRefusal) setRefusal(null); }}
                    className="h-9 max-w-sm font-mono"
                    aria-label={t('spaces.apply.branch.label')}
                  />
                  {branchRefusal ? <p className="typography-meta text-status-error">{refusalText(branchRefusal)}</p> : null}
                </div>
              ) : null}
              {option('changes', t('spaces.apply.as.changes'), changesClosed)}
              {changesClosed ? <p className="pl-6 typography-meta text-muted-foreground">{t('spaces.apply.changes.closed')}</p> : null}
              {!changesClosed && preview.newPathsUndecided ? <p className="pl-6 typography-meta text-status-warning">{t('spaces.apply.changes.undecided')}</p> : null}
              {!changesClosed && !preview.newPathsUndecided && sinceLastApply ? <p className="pl-6 typography-meta text-muted-foreground">{sinceLastApply}</p> : null}
            </div>
          )}

          {nothingChanged ? null : (
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox checked={removeAfterwards} onChange={setRemoveAfterwards} ariaLabel={t('spaces.apply.removeAfterwards')} />
              <span className="typography-ui-label text-foreground">{t('spaces.apply.removeAfterwards')}</span>
            </label>
          )}
        </>
      ) : null}
    </div>
  );

  const title = t('spaces.apply.title', { name });
  const footer = (
    <div className="flex w-full items-center justify-end gap-2">
      <Button variant="outline" size="sm" onClick={close} disabled={applying}>{t('spaces.apply.cancel')}</Button>
      <Button size="sm" onClick={() => void apply()} disabled={!canApply} className="gap-1.5">
        {applying ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
        {applying ? t('spaces.apply.applying') : t('spaces.apply.confirm')}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel open title={title} onClose={() => { if (!applying) close(); }} footer={footer}>
        <div className="px-3 pb-4 pt-1">{body}</div>
      </MobileOverlayPanel>
    );
  }
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !applying) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

