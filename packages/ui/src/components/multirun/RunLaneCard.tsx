import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/opencode/model';
import type { LaneSummary } from '@/lib/multirun/useLaneSummaries';
import type { LaneStatus } from '@/lib/multirun/laneStatus';
import { getSessionGoal, type SessionGoalStatus } from '@/lib/sessionGoalMetadata';
import { sessionGoalMarkLabelKey, sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { LaneStatusIcon } from './LaneStatusIcon';
import { FusionGuidance } from './FusionGuidance';
import { DiffCount } from '@/components/ui/diff-count';

const costFormatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

function LaneDuration({ session, busy }: { session: Session; busy: boolean }): React.ReactNode {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const end = busy ? now : session.time.idle;
  if (!end) return null;
  return <span className="inline-flex items-center gap-1"><Icon name="time" className="size-3" />{formatDuration(end - session.time.created)}</span>;
}

function LaneGoalMark({ status }: { status: SessionGoalStatus }): React.ReactNode {
  const { t } = useI18n();
  const label = t(sessionGoalMarkLabelKey[status]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center" role="img" aria-label={label}>
          <Icon name="target" className="size-3.5" style={{ color: sessionGoalStatusColor[status] }} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export type RunLaneCardProps = {
  session: Session;
  providerID: string;
  modelLabel: string;
  variantLabel: string | null;
  isFusion: boolean;
  busy: boolean;
  status: LaneStatus;
  unread: boolean;
  summary: LaneSummary | undefined;
  fuseSource: { checked: boolean; selectable: boolean } | null;
  hasWorktree: boolean;
  onToggleFuseSource: () => void;
  onKeep?: () => void;
  onDetach: () => void;
  onArchive: () => void;
  actionsDisabled: boolean;
  onOpenChat: () => void;
  onOpenDiff: () => void;
  guidance?: { saved: string; disabled: boolean; onSave: (text: string) => Promise<void> };
};

export function RunLaneCard({
  session,
  providerID,
  modelLabel,
  variantLabel,
  isFusion,
  busy,
  status,
  unread,
  summary,
  fuseSource,
  hasWorktree,
  onToggleFuseSource,
  onKeep,
  onDetach,
  onArchive,
  actionsDisabled,
  onOpenChat,
  onOpenDiff,
  guidance,
}: RunLaneCardProps): React.ReactNode {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = React.useState<'detach' | 'archive' | null>(null);
  const reply = summary?.reply;
  const diff = summary?.diff;
  const excluded = fuseSource !== null && !fuseSource.checked;
  const goal = getSessionGoal(session);
  const replyText = reply?.state === 'ready' ? reply.text : '';

  let body: React.ReactNode;
  if (status === 'permission') body = <span className="text-foreground">{t('multirun.overview.card.body.permission')}</span>;
  else if (status === 'question') body = <span className="text-foreground">{t('multirun.overview.card.body.question')}</span>;
  else if (busy) body = <span className="text-muted-foreground italic">{t('multirun.overview.card.working')}</span>;
  else if (status === 'failed') {
    const error = reply?.state === 'ready' ? reply.error : null;
    body = <span className="text-[var(--status-error)]">{error ?? t('multirun.overview.card.body.failed')}</span>;
  } else if (status === 'notStarted') body = <span className="text-muted-foreground">{t('multirun.overview.card.body.notStarted')}</span>;
  else if (!reply || reply.state === 'loading') body = <span className="text-muted-foreground">…</span>;
  else if (reply.state === 'error') body = <span className="text-muted-foreground">{t('multirun.overview.card.replyUnavailable')}</span>;
  else if (!replyText) {
    body = <span className="text-muted-foreground">{status === 'stopped' ? t('multirun.overview.card.body.stopped') : t('multirun.overview.card.noReply')}</span>;
  } else body = replyText;

  let changes: React.ReactNode = null;
  if (diff?.state === 'ready') {
    changes = diff.stat.files === 0
      ? <span>{t('multirun.overview.card.noChanges')}</span>
      : (
        <span className="inline-flex items-center gap-1">
          <DiffCount added={diff.stat.insertions} removed={diff.stat.deletions} />
          <span>· {diff.stat.files === 1
            ? t('multirun.overview.card.filesSingle', { count: diff.stat.files })
            : t('multirun.overview.card.filesPlural', { count: diff.stat.files })}</span>
        </span>
      );
  } else if (diff?.state === 'error') {
    changes = <span>{t('multirun.overview.card.changesUnavailable')}</span>;
  }

  return (
    <div
      className={cn(
        'oc-tile relative flex min-h-[184px] flex-col gap-2 rounded-xl p-3 text-start',
        isFusion && 'col-span-full min-h-0',
        fuseSource?.checked && 'bg-interactive-selection',
        excluded && 'opacity-50',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo providerId={providerID} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate typography-ui-label font-semibold text-foreground">{modelLabel}</span>
        {variantLabel ? (
          <span className="shrink-0 rounded border border-border px-1 typography-micro text-muted-foreground">{variantLabel}</span>
        ) : null}
        {goal ? <LaneGoalMark status={goal.status} /> : null}
        <span className="ms-auto inline-flex shrink-0 items-center">
          {fuseSource ? (
            <Button
              variant="chip"
              size="icon"
              role="checkbox"
              aria-checked={fuseSource.checked}
              aria-label={t('multirun.overview.card.selectAria', { name: modelLabel })}
              disabled={!fuseSource.selectable}
              onClick={onToggleFuseSource}
            >
              <Icon name={fuseSource.checked ? 'checkbox' : 'checkbox-blank'} className="size-4" />
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {unread && status !== 'working' ? (
                <SessionActivityIndicator state="unread" />
              ) : null}
              <LaneStatusIcon status={status} />
            </span>
          )}
        </span>
      </div>
      <div className={cn('typography-meta text-foreground', isFusion ? 'line-clamp-4' : 'line-clamp-5 flex-1', 'whitespace-pre-line break-words')}>
        {body}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
        {changes}
        <LaneDuration session={session} busy={busy} />
        {session.cost > 0 ? <span>{costFormatter.format(session.cost)}</span> : null}
      </div>
      {guidance ? <FusionGuidance saved={guidance.saved} disabled={guidance.disabled} onSave={guidance.onSave} /> : null}
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChat();
            }}
          >
            <Icon name="chat-3" className="size-3.5" />
            {t('multirun.overview.card.openChat')}
          </Button>
          {onKeep ? (
            <Button variant="outline" size="xs" onClick={onKeep}>
              <Icon name="inbox-archive" className="size-3.5" />
            {t('multirun.membership.cleanup')}
            </Button>
          ) : null}
          {hasWorktree && diff?.state === 'ready' && diff.stat.files > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                onOpenDiff();
              }}
            >
              <Icon name="arrow-left-right" className="size-3.5" />
              {t('multirun.overview.card.diff')}
            </Button>
          ) : null}
          <span className="ms-auto inline-flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  disabled={actionsDisabled}
                  aria-label={t('multirun.membership.remove')}
                  onClick={() => setConfirmation('detach')}
                >
                  <Icon name="close" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('multirun.membership.remove')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  disabled={actionsDisabled}
                  aria-label={t('multirun.overview.card.archive')}
                  onClick={() => setConfirmation('archive')}
                >
                  <Icon name="inbox-archive" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('multirun.overview.card.archive')}</TooltipContent>
            </Tooltip>
          </span>
        </div>
      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation === 'archive'
              ? t('multirun.overview.card.archive')
              : t('multirun.membership.confirmTitle', { name: modelLabel })}</DialogTitle>
            <DialogDescription>{confirmation === 'archive'
              ? t('multirun.membership.archiveDescription')
              : t('multirun.membership.confirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>{t('multirun.overview.cancel')}</Button>
            <Button disabled={actionsDisabled} onClick={() => {
              const action = confirmation;
              setConfirmation(null);
              if (action === 'detach') onDetach();
              if (action === 'archive') onArchive();
            }}>
              {confirmation === 'archive' ? t('multirun.overview.card.archive') : t('multirun.membership.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
