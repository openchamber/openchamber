/**
 * The state of an isolated space. Its work row in the sidebar shows one mark at the row's end, and
 * the lines it stands for, each with the one action that moves it on, in the row's tooltip; the
 * phone's actions sheet and the lists of spaces, which have the room, write them out. While it
 * is being made (journey step 2) the step the host announced; a failed creation with the way to
 * remove it; once it runs, the access it lacks (step 4), with the way to the grant dialog; a space
 * that is stopped, broken or not answering (step 8) with the action that repairs it, and what an
 * action from the row's menu is doing or why it failed; which of the project's setup commands runs,
 * which one failed with the way to its output, or a run that was cut off (5d-4); and a session list
 * the space did not answer in full. Nothing when the space runs with its access and its setup done.
 *
 * The row has one line, so the text never sits on it: the mark says how much it matters (a spinner
 * for a wait, a stop for a stopped space, a warning, an error) and the tooltip says the rest.
 */

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
  stopped: { text: 'spaces.group.state.stopped', tone: 'stopped', action: 'start' },
  stopped_idle: { text: 'spaces.group.state.stoppedIdle', tone: 'stopped', action: 'start' },
  damaged: { text: 'spaces.group.state.damaged', tone: 'warning', action: 'restart' },
  not_answering: { text: 'spaces.group.state.notAnswering', tone: 'warning', action: 'restart' },
} satisfies Record<Exclude<SpaceCondition['kind'], 'busy' | 'action_failed' | 'unreachable'>, { text: I18nKey; tone: StatusTone; action: SpaceAction }>;

/** How much a line matters, from least to most; the mark takes the most of its lines. */
type StatusTone = 'note' | 'busy' | 'stopped' | 'warning' | 'error';
const TONE_RANK = { note: 0, busy: 1, stopped: 2, warning: 3, error: 4 } satisfies Record<StatusTone, number>;

type StatusLine = { tone: StatusTone; text: string; action?: { label: string; run: () => void } };

// A command as the line shows it: its first line, cut short; the output window shows it whole.
const MAX_COMMAND_SHOWN = 80;
const shownCommand = (command: string): string => {
  const lines = command.trim().split('\n');
  const first = lines[0] ?? '';
  return first.length > MAX_COMMAND_SHOWN || lines.length > 1 ? `${first.slice(0, MAX_COMMAND_SHOWN)}…` : first;
};

/** What the space's state says, most pressing first; empty when there is nothing to say. */
const useSpaceStatusLines = (spaceId: string): StatusLine[] => {
  const { t } = useI18n();
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const mark = useSpacesStore((state) => state.spaces.get(spaceId));
  const action = useSpacesStore((state) => state.actions.get(spaceId));
  const catalog = useConfigStore((state) => state.providers);
  const providerName = (providerId: string) => catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  const condition = spaceConditionOf(entry, mark, action);
  // Delete asks first; every other repair runs at once (the maintainer's call: nothing is lost).
  const repair = (next: SpaceAction): StatusLine['action'] => ({
    label: t(SPACE_ACTION_TEXT[next]),
    run: () => (next === 'remove' ? useSpacesStore.getState().openDeleteDialog(spaceId) : void runSpaceAction(spaceId, next)),
  });
  // The way to the grant dialog, opened on the provider that lacks access.
  const grant = (providerId: string | null): StatusLine['action'] => ({
    label: t('spaces.group.access.give'),
    run: () => useSpacesStore.getState().openAccessDialog(spaceId, providerId),
  });

  if (entry?.state === 'preparing' && entry.step && entry.step !== 'ready' && entry.step !== 'failed') {
    return [{ tone: 'busy', text: t(STEP_TEXT[entry.step]) }];
  }
  if (condition?.kind === 'busy') return [{ tone: 'busy', text: t(BUSY_TEXT[condition.action]) }];
  if (entry?.state === 'failed') {
    // Dismissing a failed creation removes what is left of it, without a confirmation: its code never arrived.
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
  // The machine is off or out of reach: nothing to do here but wait, or, once the machine left
  // Settings, delete the space, which forgets its record and nothing else.
  if (condition?.kind === 'unreachable') {
    const text = condition.gone
      ? t('spaces.group.state.machineRemoved')
      : condition.machine === null ? t('spaces.group.state.unreachable') : t('spaces.group.state.unreachableMachine', { machine: condition.machine });
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
    // A failed command leaves the space working, so it reads as a warning; its output window
    // says what happened and offers the run again.
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

  // The space did not answer the host's last read in full: its last known sessions stand in, and
  // the user should know they may be old. A stopped, unreachable or silent space says so above
  // instead; this line speaks for the rest, a list read in part or one the journey has no entry for.
  if (mark && mark.state !== 'complete') lines.push({ tone: 'warning', text: t('sessions.sidebar.group.spaceStale') });
  return lines;
};

const LineIcon: React.FC<{ tone: StatusTone; className: string }> = ({ tone, className }) => {
  if (tone === 'busy') return <Spinner className={className} />;
  const name = tone === 'error' ? 'error-warning' : tone === 'stopped' ? 'stop' : 'alert';
  return <Icon name={name} className={className} />;
};

const TONE_CLASS = {
  note: 'text-muted-foreground',
  busy: 'text-muted-foreground',
  stopped: 'text-muted-foreground',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
} satisfies Record<StatusTone, string>;

/**
 * The state written out, each line with the action that moves it on: in the work row's tooltip,
 * on the phone's actions sheet, and in the lists of spaces, which have the room. `onAction` runs
 * before a line's action, for a surface that closes first.
 */
export const SpaceStatusLines: React.FC<{
  spaceId: string;
  className?: string;
  onAction?: () => void;
  /** Leaves out the stopped line, for a row that names the state and offers Start itself. */
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

/**
 * The mark at the end of a space's work row, as much as the most pressing line matters; nothing
 * while there is nothing to say. The row's tooltip and the phone's sheet say the rest.
 */
export const SpaceStatusMark: React.FC<{ spaceId: string; className?: string }> = ({ spaceId, className }) => {
  const { t } = useI18n();
  const lines = useSpaceStatusLines(spaceId);
  if (lines.length === 0) return null;
  const tone = lines.reduce<StatusTone>((top, line) => (TONE_RANK[line.tone] > TONE_RANK[top] ? line.tone : top), 'note');
  // A stopped space is a resting state, not a fault: a word where a row's time goes. A square
  // there read as a Stop button (maintainer, 2026-10-26).
  if (tone === 'stopped') {
    return <span className={cn('flex-shrink-0 typography-micro text-muted-foreground', className)}>{t('spaces.row.state.stopped')}</span>;
  }
  return (
    <span role="img" aria-label={lines[0]?.text} className={cn('inline-flex flex-shrink-0 items-center', TONE_CLASS[tone], className)}>
      <LineIcon tone={tone} className="size-3" />
    </span>
  );
};
