import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/opencode/model';
import type { LaneSummary } from '@/lib/multirun/useLaneSummaries';
import type { LaneStatus } from '@/lib/multirun/laneStatus';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { LaneStatusIcon } from './LaneStatusIcon';

const costFormatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

/** Time the member has worked: from creation to its last idle, live while it runs. */
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

export type RunLaneCardProps = {
  session: Session;
  providerID: string;
  modelLabel: string;
  variantLabel: string | null;
  isFusion: boolean;
  busy: boolean;
  status: LaneStatus;
  /** The member has activity the user has not opened yet. */
  unread: boolean;
  summary: LaneSummary | undefined;
  /** Present while the fuse bar is open: whether this card is a fusion source. */
  fuseSource: { checked: boolean; selectable: boolean } | null;
  hasWorktree: boolean;
  onToggleFuseSource: () => void;
  /** Offered on finished cards of an isolated run: keep this one, clean up the rest. */
  onKeep?: () => void;
  /** Leave the run as an ordinary session. */
  onDetach: () => void;
  /** Archive this member only; the rest of the run stays. */
  onArchive: () => void;
  actionsDisabled: boolean;
  onOpenChat: () => void;
  onOpenDiff: () => void;
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
}: RunLaneCardProps): React.ReactNode {
  const { t } = useI18n();
  const reply = summary?.reply;
  const diff = summary?.diff;
  const excluded = fuseSource !== null && !fuseSource.checked;
  const replyText = reply?.state === 'ready' ? reply.text : '';

  // What stands where the reply goes: a lane that needs the user or broke
  // says so first; a stopped lane still shows what it had written.
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
          <span className="text-[var(--status-success)]">+{diff.stat.insertions}</span>
          <span className="text-[var(--status-error)]">−{diff.stat.deletions}</span>
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
      role={fuseSource ? 'checkbox' : undefined}
      tabIndex={fuseSource ? 0 : undefined}
      aria-checked={fuseSource ? fuseSource.checked : undefined}
      aria-label={fuseSource ? t('multirun.overview.card.selectAria', { name: modelLabel }) : undefined}
      onClick={fuseSource ? onToggleFuseSource : undefined}
      onKeyDown={fuseSource ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleFuseSource();
        }
      } : undefined}
      className={cn(
        'relative flex min-h-[184px] flex-col gap-2 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'bg-[var(--surface-elevated)] border-border hover:border-[var(--interactive-border-hover)]',
        isFusion && 'col-span-full min-h-0 border-[color-mix(in_srgb,var(--primary-base)_35%,transparent)]',
        fuseSource && 'cursor-pointer',
        fuseSource?.checked && 'border-[var(--primary-base)]',
        excluded && 'opacity-50',
        fuseSource && !fuseSource.selectable && 'cursor-not-allowed',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo providerId={providerID} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate typography-ui-label font-semibold text-foreground">{modelLabel}</span>
        {variantLabel ? (
          <span className="shrink-0 rounded border border-border px-1 typography-micro text-muted-foreground">{variantLabel}</span>
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center">
          {fuseSource ? (
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-4 items-center justify-center rounded border',
                fuseSource.checked ? 'border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)]' : 'border-[var(--interactive-border-hover)]',
              )}
            >
              {fuseSource.checked ? <Icon name="check" className="size-3" /> : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {unread && status !== 'working' ? (
                <SessionActivityIndicator state="unread" label={t('sessions.sidebar.session.status.unread')} />
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
      {fuseSource ? null : (
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
              <Icon name="check" className="size-3.5" />
              {t('multirun.overview.card.keep')}
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
          <span className="ml-auto inline-flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  disabled={actionsDisabled}
                  aria-label={t('multirun.overview.card.detach')}
                  onClick={onDetach}
                >
                  <Icon name="external-link" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('multirun.overview.card.detachHint')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  disabled={actionsDisabled}
                  aria-label={t('multirun.overview.card.archive')}
                  onClick={onArchive}
                >
                  <Icon name="inbox-archive" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('multirun.overview.card.archive')}</TooltipContent>
            </Tooltip>
          </span>
        </div>
      )}
    </div>
  );
}
