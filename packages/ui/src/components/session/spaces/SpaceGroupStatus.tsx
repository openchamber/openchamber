/**
 * The status line under an isolated space's group in the sidebar: while it is being made (DESIGN.md,
 * user journey step 2) the step the host announced, the model access this window is giving, a
 * failed creation with the way to remove it, or access that could not be given; once it runs, what
 * access it lacks (step 4), read from the gatekeeper through the journey list, with the way to the
 * grant dialog. Since 5d-2 (step 8) it also says when a space is stopped, broken or not answering,
 * with the one action that repairs it, and what an action from the group's menu is doing or why it
 * failed. Nothing when the space runs with its access; the group then behaves like any other.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { SpaceCreationStep } from '@/lib/spaces/spaces-api';
import { spaceAccessNoticeOf } from '@/lib/spaces/space-access';
import { runSpaceAction, spaceConditionOf, type SpaceCondition } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';
import { spaceFailureText } from './spaceFailureText';

const STEP_TEXT = {
  checking_place: 'spaces.group.step.checkingPlace',
  creating: 'spaces.group.step.creating',
  setting_network: 'spaces.group.step.settingNetwork',
  bringing_code: 'spaces.group.step.bringingCode',
} satisfies Record<Exclude<SpaceCreationStep, 'ready'>, I18nKey>;

const BUSY_TEXT = {
  start: 'spaces.group.busy.start',
  stop: 'spaces.group.busy.stop',
  restart_opencode: 'spaces.group.busy.restartOpenCode',
  restart: 'spaces.group.busy.restart',
  remove: 'spaces.group.busy.remove',
} satisfies Record<SpaceAction, I18nKey>;

const FAILED_TEXT = {
  start: 'spaces.group.actionFailed.start',
  stop: 'spaces.group.actionFailed.stop',
  restart_opencode: 'spaces.group.actionFailed.restartOpenCode',
  restart: 'spaces.group.actionFailed.restart',
  remove: 'spaces.group.actionFailed.remove',
} satisfies Record<SpaceAction, I18nKey>;

// What each state says, how it is coloured, and the one action that repairs it.
const STATE_LINE = {
  container_gone: { text: 'spaces.group.state.containerGone', tone: 'warning', action: 'remove' },
  gatekeeper_gone: { text: 'spaces.group.state.gatekeeperGone', tone: 'error', action: 'remove' },
  stopped: { text: 'spaces.group.state.stopped', tone: 'muted', action: 'start' },
  stopped_idle: { text: 'spaces.group.state.stoppedIdle', tone: 'muted', action: 'start' },
  damaged: { text: 'spaces.group.state.damaged', tone: 'warning', action: 'restart' },
  not_answering: { text: 'spaces.group.state.notAnswering', tone: 'warning', action: 'restart' },
} satisfies Record<Exclude<SpaceCondition['kind'], 'busy' | 'action_failed'>, { text: I18nKey; tone: 'muted' | 'warning' | 'error'; action: SpaceAction }>;

const Line: React.FC<{ icon: 'loader-4' | 'error-warning' | 'alert' | 'stop'; tone: 'muted' | 'error' | 'warning'; children: React.ReactNode }> = ({ icon, tone, children }) => (
  <span className={tone === 'error' ? 'flex items-start gap-1.5 text-[var(--status-error)]' : tone === 'warning' ? 'flex items-start gap-1.5 text-[var(--status-warning)]' : 'flex items-start gap-1.5 text-muted-foreground'}>
    <Icon name={icon} className={icon === 'loader-4' ? 'mt-px h-3 w-3 shrink-0 animate-spin' : 'mt-px h-3 w-3 shrink-0'} />
    <span className="min-w-0 whitespace-normal break-words text-[11px] leading-tight">{children}</span>
  </span>
);

export const SpaceGroupStatus: React.FC<{ spaceId: string; className?: string }> = ({ spaceId, className }) => {
  const { t } = useI18n();
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const access = useSpacesStore((state) => state.creationAccess.get(spaceId));
  const catalog = useConfigStore((state) => state.providers);
  const providerName = (providerId: string) => catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  const grantButton = (providerId: string | null = null) => (
    <Button variant="outline" size="xs" className="self-start" onClick={() => useSpacesStore.getState().openAccessDialog(spaceId, providerId)}>
      {t('spaces.group.access.give')}
    </Button>
  );
  const mark = useSpacesStore((state) => state.spaces.get(spaceId));
  const action = useSpacesStore((state) => state.actions.get(spaceId));
  const condition = spaceConditionOf(entry, mark, action);
  // Delete asks first; every other repair runs at once (the maintainer's call: nothing is lost).
  const actionButton = (next: SpaceAction) => (
    <Button
      variant="outline"
      size="xs"
      className="self-start"
      onClick={() => (next === 'remove' ? useSpacesStore.getState().openDeleteDialog(spaceId) : void runSpaceAction(spaceId, next))}
    >
      {t(SPACE_ACTION_TEXT[next])}
    </Button>
  );

  if (entry?.state === 'preparing' && entry.step && entry.step !== 'ready') {
    return (
      <div className={className}>
        <Line icon="loader-4" tone="muted">
          {t(STEP_TEXT[entry.step])}
          {entry.step === 'creating' ? ` ${t('spaces.group.step.creatingFirstTime')}` : null}
        </Line>
      </div>
    );
  }

  if (condition?.kind === 'busy') {
    return <div className={className}><Line icon="loader-4" tone="muted">{t(BUSY_TEXT[condition.action])}</Line></div>;
  }

  if (entry?.state === 'failed') {
    // Dismissing a failed creation removes what is left of it, without a confirmation: its code never arrived.
    const removeFailure = action?.kind === 'failed' ? action.failure : null;
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon="error-warning" tone="error">
          {t('spaces.group.failed', { reason: entry.failure ? spaceFailureText(t, entry.failure) : t('spaces.group.failedNoReason') })}
        </Line>
        {removeFailure ? <Line icon="error-warning" tone="error">{t('spaces.group.removeFailed', { reason: spaceFailureText(t, removeFailure) })}</Line> : null}
        <Button variant="outline" size="xs" className="self-start" onClick={() => void runSpaceAction(spaceId, 'remove')}>
          {t('spaces.group.remove')}
        </Button>
      </div>
    );
  }

  if (condition?.kind === 'action_failed') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon="error-warning" tone="error">{t(FAILED_TEXT[condition.action], { reason: spaceFailureText(t, condition.failure) })}</Line>
        {actionButton(condition.action)}
      </div>
    );
  }

  if (condition) {
    const line = STATE_LINE[condition.kind];
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon={line.tone === 'muted' ? 'stop' : line.tone === 'error' ? 'error-warning' : 'alert'} tone={line.tone}>{t(line.text)}</Line>
        {actionButton(line.action)}
      </div>
    );
  }

  if (access?.kind === 'giving') {
    return <div className={className}><Line icon="loader-4" tone="muted">{t('spaces.group.step.givingAccess')}</Line></div>;
  }

  if (access?.kind === 'failed') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        {access.failures.map((failure) => (
          <Line key={failure.provider} icon="alert" tone="warning">
            {t('spaces.group.accessMissing', { provider: providerName(failure.provider), reason: spaceFailureText(t, failure) })}
          </Line>
        ))}
        {grantButton(access.failures[0]?.provider ?? null)}
      </div>
    );
  }

  const notice = spaceAccessNoticeOf(entry);
  if (notice?.kind === 'needs_again') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        {notice.providers.map((providerId) => (
          <Line key={providerId} icon="alert" tone="warning">{t('spaces.group.access.needsAgain', { provider: providerName(providerId) })}</Line>
        ))}
        {grantButton(notice.providers[0])}
      </div>
    );
  }
  if (notice?.kind === 'no_model') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon="alert" tone="warning">{t('spaces.group.access.noModel')}</Line>
        {grantButton()}
      </div>
    );
  }
  if (notice?.kind === 'unknown') {
    return <div className={className}><Line icon="alert" tone="muted">{t('spaces.group.access.unknown')}</Line></div>;
  }

  return null;
};
