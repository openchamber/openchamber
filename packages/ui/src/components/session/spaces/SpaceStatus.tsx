
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { SPACE_LOGIN_NAMES } from '@/lib/spaces/model-access';
import { providerGrantOf, type SpaceCreationStep } from '@/lib/spaces/spaces-api';
import { spaceAccessNoticeOf } from '@/lib/spaces/space-access';
import { runSpaceAction, spaceConditionOf, type SpaceCondition } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
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

const STATE_LINE = {
  container_gone: { text: 'spaces.group.state.containerGone', tone: 'warning', action: 'remove' },
  gatekeeper_gone: { text: 'spaces.group.state.gatekeeperGone', tone: 'error', action: 'remove' },
  stopped: { text: 'spaces.group.state.stopped', tone: 'stopped', action: 'start' },
  stopped_idle: { text: 'spaces.group.state.stoppedIdle', tone: 'stopped', action: 'start' },
  damaged: { text: 'spaces.group.state.damaged', tone: 'warning', action: 'restart' },
  not_answering: { text: 'spaces.group.state.notAnswering', tone: 'warning', action: 'restart' },
} satisfies Record<Exclude<SpaceCondition['kind'], 'busy' | 'action_failed' | 'unreachable'>, { text: I18nKey; tone: StatusTone; action: SpaceAction }>;

type StatusTone = 'note' | 'busy' | 'stopped' | 'warning' | 'error';
const TONE_RANK = { note: 0, busy: 1, stopped: 2, warning: 3, error: 4 } satisfies Record<StatusTone, number>;

type StatusLine = { tone: StatusTone; text: string; action?: { label: string; run: () => void } };

const MAX_COMMAND_SHOWN = 80;
const shownCommand = (command: string): string => {
  const lines = command.trim().split('\n');
  const first = lines[0] ?? '';
  return first.length > MAX_COMMAND_SHOWN || lines.length > 1 ? `${first.slice(0, MAX_COMMAND_SHOWN)}…` : first;
};

const useSpaceStatusLines = (spaceId: string): StatusLine[] => {
  const { t } = useI18n();
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const mark = useSpacesStore((state) => state.spaces.get(spaceId));
  const action = useSpacesStore((state) => state.actions.get(spaceId));
  const catalog = useConfigStore((state) => state.providers);
  const providerName = (providerId: string) => catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  const condition = spaceConditionOf(entry, mark, action);
  const repair = (next: SpaceAction): StatusLine['action'] => ({
    label: t(SPACE_ACTION_TEXT[next]),
    run: () => (next === 'remove' ? useSpacesStore.getState().openDeleteDialog(spaceId) : void runSpaceAction(spaceId, next)),
  });
  const grant = (providerId: string | null): StatusLine['action'] => ({
    label: t('spaces.group.access.give'),
    run: () => useSpacesStore.getState().openAccessDialog(spaceId, providerId),
  });

  if (entry?.state === 'preparing' && entry.step && entry.step !== 'ready' && entry.step !== 'failed') {
    return [{ tone: 'busy', text: t(STEP_TEXT[entry.step]) }];
  }
  if (condition?.kind === 'busy') return [{ tone: 'busy', text: t(BUSY_TEXT[condition.action]) }];
  if (entry?.state === 'failed') {
    const failed = t('spaces.group.failed', { reason: entry.failure ? spaceFailureText(t, entry.failure) : t('spaces.group.failedNoReason') });
    const remove = { label: t('spaces.group.remove'), run: () => void runSpaceAction(spaceId, 'remove') };
    const removeFailure = action?.kind === 'failed' ? action.failure : null;
    return removeFailure
      ? [{ tone: 'error', text: failed }, { tone: 'error', text: t('spaces.group.removeFailed', { reason: spaceFailureText(t, removeFailure) }), action: remove }]
      : [{ tone: 'error', text: failed, action: remove }];
  }
  if (condition?.kind === 'action_failed' && condition.action === 'setup' && (condition.failure.code === 'space_setup_no_commands' || condition.failure.code === 'space_setup_shared_skipped')) {
    return [{ tone: 'note', text: t(condition.failure.code === 'space_setup_no_commands' ? 'spaces.group.setup.noCommands' : 'spaces.group.setup.sharedSkipped') }];
  }
  if (condition?.kind === 'action_failed') {
    return [{ tone: 'error', text: t(FAILED_TEXT[condition.action], { reason: spaceFailureText(t, condition.failure) }), action: repair(condition.action) }];
  }
  if (condition?.kind === 'unreachable') {
    if (!condition.gone && condition.machine === null) {
      return [{ tone: 'warning', text: t('spaces.group.state.dockerNotRunning'), action: { label: t('spaces.group.state.openDockerSettings'), run: () => useUIStore.getState().openSettingsAt('isolated-spaces') } }];
    }
    const text = condition.gone
      ? t('spaces.group.state.machineRemoved')
      : t('spaces.group.state.unreachableMachine', { machine: condition.machine ?? '' });
    return [{ tone: 'warning', text, action: condition.gone ? repair('remove') : undefined }];
  }
  if (condition) {
    const line = STATE_LINE[condition.kind];
    return [{ tone: line.tone, text: t(line.text), action: repair(line.action) }];
  }

  const lines: StatusLine[] = [];
  const setup = entry?.state === 'running' ? entry.setup : null;
  if (setup?.state === 'running') {
    lines.push({ tone: 'busy', text: t('spaces.group.setup.running', { current: setup.index + 1, total: setup.total, command: shownCommand(setup.command) }) });
  } else if (setup?.state === 'interrupted') {
    lines.push({ tone: 'warning', text: t('spaces.group.setup.interrupted'), action: { label: t('spaces.group.setup.runAgain'), run: () => void runSpaceAction(spaceId, 'setup') } });
  } else if (setup?.state === 'failed') {
    lines.push({
      tone: 'warning',
      text: t(setup.timedOut ? 'spaces.group.setup.timedOut' : 'spaces.group.setup.failed', { command: shownCommand(setup.command) }),
      action: { label: t('spaces.group.setup.output'), run: () => useSpacesStore.getState().openSetupOutputDialog(spaceId) },
    });
  }

  const failures = entry?.accessFailures ?? [];
  const notice = spaceAccessNoticeOf(entry);
  if (failures.length > 0) {
    for (const failure of failures) {
      const reason = spaceFailureText(t, failure, { name: SPACE_LOGIN_NAMES.get(failure.provider) ?? providerName(failure.provider) });
      lines.push({ tone: 'warning', text: t('spaces.group.accessMissing', { provider: providerName(failure.provider), reason }), action: grant(failure.provider) });
    }
  } else if (notice?.kind === 'needs_again') {
    for (const providerId of notice.providers) {
      const text = providerGrantOf(entry?.grants ?? [], providerId)?.kind === 'login'
        ? t('spaces.group.access.loginNeedsAgain', { name: SPACE_LOGIN_NAMES.get(providerId) ?? providerName(providerId) })
        : t('spaces.group.access.needsAgain', { provider: providerName(providerId) });
      lines.push({ tone: 'warning', text, action: grant(providerId) });
    }
  } else if (notice?.kind === 'no_model') {
    lines.push({ tone: 'warning', text: t('spaces.group.access.noModel'), action: grant(null) });
  } else if (notice?.kind === 'unknown') {
    lines.push({ tone: 'note', text: t('spaces.group.access.unknown') });
  }

  if (mark && mark.state !== 'complete') lines.push({ tone: 'warning', text: t('sessions.sidebar.group.spaceStale') });
  return lines;
};

const LineIcon: React.FC<{ tone: StatusTone; className: string }> = ({ tone, className }) => {
  if (tone === 'busy') return <Spinner className={className} />;
  const name = tone === 'error' ? 'error-warning' : tone === 'stopped' ? 'stop' : tone === 'note' ? 'information' : 'alert';
  return <Icon name={name} className={className} />;
};

const TONE_CLASS = {
  note: 'text-muted-foreground',
  busy: 'text-muted-foreground',
  stopped: 'text-muted-foreground',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
} satisfies Record<StatusTone, string>;

export const SpaceStatusLines: React.FC<{
  spaceId: string;
  className?: string;
  onAction?: () => void;
  hideStopped?: boolean;
}> = ({ spaceId, className, onAction, hideStopped = false }) => {
  const all = useSpaceStatusLines(spaceId);
  const lines = hideStopped ? all.filter((line) => line.tone !== 'stopped') : all;
  if (lines.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {lines.map((line, index) => (
        <div key={index} className="flex flex-col items-start gap-1.5">
          <span className={cn('flex items-start gap-1.5', TONE_CLASS[line.tone])}>
            <LineIcon tone={line.tone} className="mt-px size-3 shrink-0" />
            <span className="min-w-0 whitespace-normal break-words typography-meta">{line.text}</span>
          </span>
          {line.action ? (
            <Button
              variant="outline"
              size="xs"
              className="ms-[1.125rem]"
              onClick={(event) => {
                event.stopPropagation();
                onAction?.();
                line.action?.run();
              }}
            >
              {line.action.label}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
};

export const SpaceStatusMark: React.FC<{ spaceId: string; className?: string }> = ({ spaceId, className }) => {
  const { t } = useI18n();
  const lines = useSpaceStatusLines(spaceId);
  if (lines.length === 0) return null;
  const tone = lines.reduce<StatusTone>((top, line) => (TONE_RANK[line.tone] > TONE_RANK[top] ? line.tone : top), 'note');
  if (tone === 'stopped') {
    return <span className={cn('flex-shrink-0 typography-micro text-muted-foreground', className)}>{t('spaces.row.state.stopped')}</span>;
  }
  return (
    <span role="img" aria-label={lines[0]?.text} className={cn('inline-flex flex-shrink-0 items-center', TONE_CLASS[tone], className)}>
      <LineIcon tone={tone} className="size-3" />
    </span>
  );
};
