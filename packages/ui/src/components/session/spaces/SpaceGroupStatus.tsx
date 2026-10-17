/**
 * The status line under an isolated space's group in the sidebar: while it is being made (journey step 2) the step the host announced, the model access this window is giving, a
 * failed creation with the way to remove it, or access that could not be given; once it runs, what
 * access it lacks (step 4), read from the gatekeeper through the journey list, with the way to the
 * grant dialog. Since 5d-2 (step 8) it also says when a space is stopped, broken or not answering,
 * with the one action that repairs it, and what an action from the group's menu is doing or why it
 * failed. Since 5d-4 it says which of the project's setup commands runs, which one failed, with its
 * output and a way to run them again, or that a run was cut off. Nothing when the space runs with
 * its access and its setup done; the group then behaves like any other.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { SPACE_LOGIN_NAMES } from '@/lib/spaces/model-access';
import { providerGrantOf, type SpaceCreationStep, type SpaceSetup } from '@/lib/spaces/spaces-api';
import { spaceAccessNoticeOf } from '@/lib/spaces/space-access';
import { runSpaceAction, spaceConditionOf, type SpaceCondition } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';
import { spaceFailureText } from './spaceFailureText';

const STEP_TEXT = {
  checking_place: 'spaces.group.step.checkingPlace',
  creating: 'spaces.group.step.creating',
  downloading_image: 'spaces.group.step.downloadingImage',
  preparing_tools: 'spaces.group.step.preparingTools',
  setting_network: 'spaces.group.step.settingNetwork',
  bringing_code: 'spaces.group.step.bringingCode',
  giving_access: 'spaces.group.step.givingAccess',
} satisfies Record<Exclude<SpaceCreationStep, 'ready'>, I18nKey>;

const BUSY_TEXT = {
  start: 'spaces.group.busy.start',
  stop: 'spaces.group.busy.stop',
  restart_opencode: 'spaces.group.busy.restartOpenCode',
  restart: 'spaces.group.busy.restart',
  setup: 'spaces.group.busy.setup',
  remove: 'spaces.group.busy.remove',
} satisfies Record<SpaceAction, I18nKey>;

const FAILED_TEXT = {
  start: 'spaces.group.actionFailed.start',
  stop: 'spaces.group.actionFailed.stop',
  restart_opencode: 'spaces.group.actionFailed.restartOpenCode',
  restart: 'spaces.group.actionFailed.restart',
  setup: 'spaces.group.actionFailed.setup',
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
} satisfies Record<Exclude<SpaceCondition['kind'], 'busy' | 'action_failed' | 'unreachable'>, { text: I18nKey; tone: 'muted' | 'warning' | 'error'; action: SpaceAction }>;

const Line: React.FC<{ icon: 'loader-4' | 'error-warning' | 'alert' | 'stop'; tone: 'muted' | 'error' | 'warning'; children: React.ReactNode }> = ({ icon, tone, children }) => (
  <span className={tone === 'error' ? 'flex items-start gap-1.5 text-[var(--status-error)]' : tone === 'warning' ? 'flex items-start gap-1.5 text-[var(--status-warning)]' : 'flex items-start gap-1.5 text-muted-foreground'}>
    {icon === 'loader-4' ? <Spinner className="mt-px h-3 w-3 shrink-0" /> : <Icon name={icon} className="mt-px h-3 w-3 shrink-0" />}
    <span className="min-w-0 whitespace-normal break-words text-[11px] leading-tight">{children}</span>
  </span>
);

// A command as the line shows it: its first line, cut short; the output window shows it whole.
const MAX_COMMAND_SHOWN = 80;
const shownCommand = (command: string): string => {
  const lines = command.trim().split('\n');
  const first = lines[0] ?? '';
  return first.length > MAX_COMMAND_SHOWN || lines.length > 1 ? `${first.slice(0, MAX_COMMAND_SHOWN)}…` : first;
};

// A status line that opens something: no hover fill, the text rests at 80% and turns full on hover.
const LINE_BUTTON_CLASS = 'self-start rounded text-start opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The setup commands' line: which runs now, which failed with its output, or a run cut off. */
const SetupLine: React.FC<{ spaceId: string; setup: SpaceSetup | null }> = ({ spaceId, setup }) => {
  const { t } = useI18n();
  if (!setup || setup.state === 'done' || setup.state === 'queued') return null;
  const runAgain = (
    <Button variant="outline" size="xs" onClick={() => void runSpaceAction(spaceId, 'setup')}>
      {t('spaces.group.setup.runAgain')}
    </Button>
  );
  if (setup.state === 'running') {
    return (
      <Line icon="loader-4" tone="muted">
        {t('spaces.group.setup.running', { current: setup.index + 1, total: setup.total, command: shownCommand(setup.command) })}
      </Line>
    );
  }
  if (setup.state === 'interrupted') {
    return (
      <div className="flex flex-col gap-1">
        <Line icon="alert" tone="warning">{t('spaces.group.setup.interrupted')}</Line>
        <div className="flex flex-wrap gap-1">{runAgain}</div>
      </div>
    );
  }
  // A failed command leaves the space working, so it reads as a warning, and the line itself opens
  // the window that says what happened and offers the run again.
  return (
    <button
      type="button"
      className={LINE_BUTTON_CLASS}
      title={t('spaces.group.setup.output')}
      onClick={() => useSpacesStore.getState().openSetupOutputDialog(spaceId)}
    >
      <Line icon="alert" tone="warning">
        {t(setup.timedOut ? 'spaces.group.setup.timedOut' : 'spaces.group.setup.failed', { command: shownCommand(setup.command) })}
      </Line>
    </button>
  );
};

export const SpaceGroupStatus: React.FC<{ spaceId: string; className?: string }> = ({ spaceId, className }) => {
  const { t } = useI18n();
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const catalog = useConfigStore((state) => state.providers);
  const providerName = (providerId: string) => catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  // The access line is the way to the grant dialog (the maintainer's call of 2026-10-08): no
  // button under it, the line itself opens the dialog, named "Grant access" for the pointer and
  // the screen reader.
  const grantLine = (providerId: string | null, children: React.ReactNode) => (
    <button
      type="button"
      className={LINE_BUTTON_CLASS}
      title={t('spaces.group.access.give')}
      aria-label={t('spaces.group.access.giveAria', { label: entry?.name ?? '' })}
      onClick={() => useSpacesStore.getState().openAccessDialog(spaceId, providerId)}
    >
      <Line icon="alert" tone="warning">{children}</Line>
    </button>
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

  if (entry?.state === 'preparing' && entry.step && entry.step !== 'ready' && entry.step !== 'failed') {
    return (
      <div className={className}>
        <Line icon="loader-4" tone="muted">{t(STEP_TEXT[entry.step])}</Line>
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

  if (condition?.kind === 'action_failed' && condition.action === 'setup' && (condition.failure.code === 'space_setup_no_commands' || condition.failure.code === 'space_setup_shared_skipped')) {
    return (
      <div className={className}>
        <Line icon="alert" tone="muted">{t(condition.failure.code === 'space_setup_no_commands' ? 'spaces.group.setup.noCommands' : 'spaces.group.setup.sharedSkipped')}</Line>
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

  // The machine is off or out of reach: nothing to do here but wait, or, once the machine left
  // Settings, delete the space, which forgets its record and nothing else.
  if (condition?.kind === 'unreachable') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Line icon="alert" tone="warning">
          {condition.gone
            ? t('spaces.group.state.machineRemoved')
            : condition.machine === null ? t('spaces.group.state.unreachable') : t('spaces.group.state.unreachableMachine', { machine: condition.machine })}
        </Line>
        {condition.gone ? actionButton('remove') : null}
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

  const accessLine = (() => {
    const failures = entry?.accessFailures ?? [];
    if (failures.length > 0) {
      return (
        <div className="flex flex-col gap-1">
          {failures.map((failure) => (
            <React.Fragment key={failure.provider}>
              {grantLine(failure.provider, t('spaces.group.accessMissing', { provider: providerName(failure.provider), reason: spaceFailureText(t, failure, { name: SPACE_LOGIN_NAMES.get(failure.provider) ?? providerName(failure.provider) }) }))}
            </React.Fragment>
          ))}
        </div>
      );
    }

    const notice = spaceAccessNoticeOf(entry);
    if (notice?.kind === 'needs_again') {
      return (
        <div className="flex flex-col gap-1">
          {notice.providers.map((providerId) => (
            <React.Fragment key={providerId}>
              {grantLine(providerId, providerGrantOf(entry?.grants ?? [], providerId)?.kind === 'login'
                ? t('spaces.group.access.loginNeedsAgain', { name: SPACE_LOGIN_NAMES.get(providerId) ?? providerName(providerId) })
                : t('spaces.group.access.needsAgain', { provider: providerName(providerId) }))}
            </React.Fragment>
          ))}
        </div>
      );
    }
    if (notice?.kind === 'no_model') {
      return <div className="flex flex-col gap-1">{grantLine(null, t('spaces.group.access.noModel'))}</div>;
    }
    if (notice?.kind === 'unknown') {
      return <div><Line icon="alert" tone="muted">{t('spaces.group.access.unknown')}</Line></div>;
    }
    return null;
  })();
  const setupLine = <SetupLine spaceId={spaceId} setup={entry?.state === 'running' ? entry.setup : null} />;
  if (!accessLine && (!entry?.setup || entry.setup.state === 'done' || entry.setup.state === 'queued' || entry.state !== 'running')) return null;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {setupLine}
      {accessLine}
    </div>
  );
};
