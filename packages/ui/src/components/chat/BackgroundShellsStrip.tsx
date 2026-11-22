import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSessionActivityDuration } from '@/components/session/sessionActivityDurationFormat';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { cn } from '@/lib/utils';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import {
  sessionsInTree,
  backgroundShellsOfSessions,
  dismissEndedShells,
  endedBackgroundShellsOfSessions,
  useBackgroundShellsStore,
  type EndedShell,
  type TrackedShell,
} from '@/sync/background-shells';

interface BackgroundShellsStripProps {
  sessionId: string | null;
  directory?: string;
}

const COMMAND_TOOLTIP_DELAY_MS = 500;

/** A command still running, or one that ended and keeps its row until dismissed. */
type ShellRowItem =
  | { kind: 'running'; shell: TrackedShell }
  | { kind: 'ended'; shell: EndedShell };

/**
 * Commands of this session and of its subagents, running or ended, in the
 * order they started, so a command keeps its row when it ends. The tree is
 * resolved only for sessions that have a row, and the result is compared as
 * a string, so the session list changing during a stream re-renders nothing
 * here.
 */
const useSessionTreeShells = (sessionId: string): ShellRowItem[] => {
  const runningSessionIds = useBackgroundShellsStore((state) => state.sessionIds);
  const endedSessionIds = useBackgroundShellsStore((state) => state.endedSessionIds);
  const treeKey = useGlobalSessionsStore(React.useCallback((state) => {
    if (runningSessionIds.size === 0 && endedSessionIds.size === 0) return '';
    const candidates = new Set([...runningSessionIds, ...endedSessionIds]);
    return sessionsInTree(candidates, sessionId, (id) => state.entityById.get(id)?.parentID ?? undefined).join('\n');
  }, [endedSessionIds, runningSessionIds, sessionId]));
  const treeIds = React.useMemo(() => new Set(treeKey ? treeKey.split('\n') : []), [treeKey]);
  const running = useBackgroundShellsStore(useShallow(React.useCallback((state) => (
    treeIds.size === 0 ? [] : backgroundShellsOfSessions(state.byId, treeIds)
  ), [treeIds])));
  const ended = useBackgroundShellsStore(useShallow(React.useCallback((state) => (
    treeIds.size === 0 ? [] : endedBackgroundShellsOfSessions(state.ended, state.dismissed, treeIds)
  ), [treeIds])));
  return React.useMemo(() => {
    const items: ShellRowItem[] = [];
    for (const shell of running) items.push({ kind: 'running', shell });
    for (const shell of ended) items.push({ kind: 'ended', shell });
    return items.sort((left, right) => left.shell.startedAt - right.shell.startedAt || left.shell.id.localeCompare(right.shell.id));
  }, [ended, running]);
};

/** Its own leaf, so the once-a-second tick re-renders this text alone. */
const ShellElapsed: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const { t } = useI18n();
  const now = useDurationTickerNow(true);
  const label = formatSessionActivityDuration(now - startedAt, t);
  return (
    <span className="shrink-0 typography-meta tabular-nums text-muted-foreground" title={t('chat.backgroundShells.elapsed', { duration: label })}>
      {label}
    </span>
  );
};

/** How an ended row reads: its label, and the colour that says success, failure or neither. */
type ShellEndView = {
  label: string;
  tone: 'text-muted-foreground' | 'text-status-success' | 'text-status-error';
};

/**
 * How a command ended, as the shell index recorded it from OpenCode. An exit
 * code is shown whenever OpenCode reported one: 0 in the success colour, any
 * other in the error colour. A stop, and an end OpenCode reported without a
 * code, carry no number.
 */
const describeShellEnd = (shell: EndedShell, t: ReturnType<typeof useI18n>['t']): ShellEndView => {
  switch (shell.status) {
    case 'exited':
      if (shell.exit === undefined) return { label: t('chat.backgroundShells.exited'), tone: 'text-muted-foreground' };
      return {
        label: t('chat.backgroundShells.exitCode', { code: shell.exit }),
        tone: shell.exit === 0 ? 'text-status-success' : 'text-status-error',
      };
    case 'timeout':
      return { label: t('chat.backgroundShells.timedOut'), tone: 'text-status-error' };
    case 'killed':
      return { label: t('chat.backgroundShells.killed'), tone: 'text-status-error' };
    case 'stopped':
      return { label: t('chat.backgroundShells.stopped'), tone: 'text-muted-foreground' };
    case 'unknown':
      return { label: t('chat.backgroundShells.ended'), tone: 'text-muted-foreground' };
  }
};

const ShellEndStatus: React.FC<{ shell: EndedShell }> = ({ shell }) => {
  const { t } = useI18n();
  const { label, tone } = describeShellEnd(shell, t);
  return <span className={cn('shrink-0 typography-meta tabular-nums', tone)}>{label}</span>;
};

const STOP_BUTTON_CLASS = 'shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error';
const ROW_ACTION_CLASS = 'shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground';

/**
 * Stops commands through the same flow as a command's row in the chat: the
 * agent is told first, then the commands are removed. Commands of one session
 * go in one call, so stopping several tells that agent once and its
 * completions arrive together. A row stays disabled until OpenCode reports
 * its command ended; the row then says how it ended.
 */
const useStopShells = (rootSessionId: string, rootDirectory: string | undefined) => {
  const { t } = useI18n();
  const [stoppingIds, setStoppingIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const stop = React.useCallback((shells: readonly TrackedShell[]) => {
    const pending = shells.filter((shell) => !stoppingIds.has(shell.id));
    if (pending.length === 0) return;
    setStoppingIds((current) => new Set([...current, ...pending.map((shell) => shell.id)]));
    const bySession = new Map<string, [TrackedShell, ...TrackedShell[]]>();
    for (const shell of pending) {
      const group = bySession.get(shell.sessionID);
      if (group) group.push(shell);
      else bySession.set(shell.sessionID, [shell]);
    }
    for (const [sessionID, [first, ...rest]] of bySession) {
      const sessionDirectory = sessionID === rootSessionId
        ? rootDirectory
        : useGlobalSessionsStore.getState().entityById.get(sessionID)?.directory ?? first.directory;
      const toStop = (shell: TrackedShell) => ({ shellID: shell.id, shellDirectory: shell.directory, command: shell.command });
      opencodeClient.stopBackgroundShells({
        sessionID,
        sessionDirectory,
        shells: [toStop(first), ...rest.map(toStop)],
      }).catch(() => {
        // A command whose kill went through ends on its own; the rest become
        // stoppable again.
        setStoppingIds((current) => {
          const next = new Set(current);
          for (const shell of [first, ...rest]) next.delete(shell.id);
          return next;
        });
        toast.error(t('chat.toolPart.background.stopFailed'));
      });
    }
  }, [rootDirectory, rootSessionId, stoppingIds, t]);

  return { stoppingIds, stop };
};

const ShellRow: React.FC<{
  item: ShellRowItem;
  fromSubagent: boolean;
  stopping: boolean;
  onStop: (shell: TrackedShell) => void;
}> = ({ item, fromSubagent, stopping, onStop }) => {
  const { t } = useI18n();
  const { shell } = item;

  return (
    <div className="flex h-10 items-center gap-2 ps-3 pe-1.5">
      <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
      <Tooltip delayDuration={COMMAND_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground">
            {shell.command}
          </span>
        </TooltipTrigger>
        {/* The row shows one truncated line; the tooltip keeps the command's
            own line breaks and indentation and wraps only overlong lines. A
            long command scrolls inside the tooltip without moving the page. */}
        <TooltipContent side="top" sideOffset={6} className="max-w-[min(36rem,90vw)] [text-wrap:wrap]">
          <pre className="max-h-[50vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words font-mono typography-meta">
            {shell.command}
          </pre>
        </TooltipContent>
      </Tooltip>
      {fromSubagent ? (
        <span className="shrink-0 typography-meta text-muted-foreground">{t('chat.backgroundShells.subagent')}</span>
      ) : null}
      {item.kind === 'running' ? (
        <>
          <ShellElapsed startedAt={shell.startedAt} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={stopping}
            onClick={() => onStop(item.shell)}
            onMouseDown={(event) => event.preventDefault()}
            aria-label={t('chat.backgroundShells.stopAria', { command: shell.command })}
            className={STOP_BUTTON_CLASS}
          >
            {t('chat.backgroundShells.stop')}
          </Button>
        </>
      ) : (
        <>
          <ShellEndStatus shell={item.shell} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => dismissEndedShells([shell.id])}
            onMouseDown={(event) => event.preventDefault()}
            title={t('chat.backgroundShells.dismiss')}
            aria-label={t('chat.backgroundShells.dismissAria', { command: shell.command })}
            className={ROW_ACTION_CLASS}
          >
            <Icon name="close" className="size-4" aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
};

/**
 * Commands the agent left running in the background (dev servers, watchers,
 * test pages), as a top row of the composer next to the "looks done" hint.
 * One command is its own row; several collapse into a count that expands in
 * place, so the composer grows by one row unless the user asks for the list.
 * A command that ends keeps its row, now saying how it ended, until the user
 * dismisses it.
 */
export const BackgroundShellsStrip: React.FC<BackgroundShellsStripProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const rows = useSessionTreeShells(sessionId ?? '');
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const { stoppingIds, stop } = useStopShells(sessionId ?? '', directory);
  const stopOne = React.useCallback((shell: TrackedShell) => stop([shell]), [stop]);

  if (!sessionId || rows.length === 0) return null;

  const row = (item: ShellRowItem) => (
    <ShellRow
      key={item.shell.id}
      item={item}
      fromSubagent={item.shell.sessionID !== sessionId}
      stopping={stoppingIds.has(item.shell.id)}
      onStop={stopOne}
    />
  );

  if (rows.length === 1) {
    return (
      <div role="group" className="border-b border-border/60" aria-label={t('chat.backgroundShells.aria')}>
        {row(rows[0])}
      </div>
    );
  }

  const running: TrackedShell[] = [];
  const endedIds: string[] = [];
  for (const item of rows) {
    if (item.kind === 'running') running.push(item.shell);
    else endedIds.push(item.shell.id);
  }

  // The header toggles the list, as the queue header does. While a command
  // runs it stops every running one at once; once none runs it dismisses them.
  return (
    <div role="group" className="border-b border-border/60" aria-label={t('chat.backgroundShells.aria')}>
      <div className="flex h-10 items-center gap-2 ps-3 pe-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          onMouseDown={(event) => event.preventDefault()}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
        >
          <Icon name="terminal-box" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start">
            {t('chat.backgroundShells.count', { count: rows.length })}
          </span>
          <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
        </Button>
        {running.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={running.every((shell) => stoppingIds.has(shell.id))}
            onClick={() => stop(running)}
            onMouseDown={(event) => event.preventDefault()}
            className={STOP_BUTTON_CLASS}
          >
            {t('chat.backgroundShells.stopAll')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => dismissEndedShells(endedIds)}
            onMouseDown={(event) => event.preventDefault()}
            className={ROW_ACTION_CLASS}
          >
            {t('chat.backgroundShells.dismissAll')}
          </Button>
        )}
      </div>
      {expanded ? (
        // Four rows, then the list scrolls, so ended commands kept for their
        // status cannot push the editor off a short screen.
        <div id={listId} className="max-h-40 overflow-y-auto overscroll-contain">
          {rows.map(row)}
        </div>
      ) : null}
    </div>
  );
});

BackgroundShellsStrip.displayName = 'BackgroundShellsStrip';
