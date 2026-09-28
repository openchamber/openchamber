/**
 * The status line under an isolated space's group in the sidebar: while it is being made (DESIGN.md,
 * user journey step 2) the step the host announced, the model access this window is giving, a
 * failed creation with the way to remove it, or access that could not be given; once it runs, what
 * access it lacks (step 4), read from the gatekeeper through the journey list, with the way to the
 * grant dialog. Nothing when the space runs with its access; the group then behaves like any other.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { removeSpace, type SpaceCreationStep } from '@/lib/spaces/spaces-api';
import { spaceAccessNoticeOf } from '@/lib/spaces/space-access';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';

const STEP_TEXT = {
  checking_place: 'spaces.group.step.checkingPlace',
  creating: 'spaces.group.step.creating',
  setting_network: 'spaces.group.step.settingNetwork',
  bringing_code: 'spaces.group.step.bringingCode',
} satisfies Record<Exclude<SpaceCreationStep, 'ready'>, I18nKey>;

const Line: React.FC<{ icon: 'loader-4' | 'error-warning' | 'alert'; tone: 'muted' | 'error' | 'warning'; children: React.ReactNode }> = ({ icon, tone, children }) => (
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
  const [removing, setRemoving] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const outcome = await removeSpace(spaceId);
      if (outcome.failures[0]) setRemoveError(t('spaces.group.removeFailed', { reason: spaceFailureText(t, outcome.failures[0]) }));
      else useSpacesStore.getState().noteCreationAccess(spaceId, null);
      await refreshSpacesJourney();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setRemoveError(t('spaces.group.removeFailed', { reason: spaceFailureText(t, failureOfError(error)) }));
    } finally {
      setRemoving(false);
    }
  };

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

  if (entry?.state === 'failed') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon="error-warning" tone="error">
          {t('spaces.group.failed', { reason: entry.failure ? spaceFailureText(t, entry.failure) : t('spaces.group.failedNoReason') })}
        </Line>
        {removeError ? <Line icon="error-warning" tone="error">{removeError}</Line> : null}
        <Button variant="outline" size="xs" className="self-start" disabled={removing} onClick={() => void remove()}>
          {t('spaces.group.remove')}
        </Button>
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
