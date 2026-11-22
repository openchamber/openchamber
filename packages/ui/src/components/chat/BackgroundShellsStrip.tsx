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
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  sessionsInTree,
  backgroundShellsOfSessions,
  dismissEndedShells,
  endedBackgroundShellsOfSessions,
  useBackgroundShellsStore,
  type EndedShell,
  type TrackedShell,
} from '@/sync/background-shells';
import { isForegroundShellStopping, useForegroundShellStopping, useForegroundShellStoppingIds } from './message/parts/foregroundShellStop';
import { backgroundImagesOfSessions, useBackgroundImagesStore } from '@/sync/background-images';
import type { RunningImageJob } from '@/lib/opencode/background-image';

interface BackgroundShellsStripProps {
  sessionId: string | null;
  directory?: string;
}

const COMMAND_TOOLTIP_DELAY_MS = 500;

const useTreeIds = (sessionId: string, workingSessionIds: ReadonlySet<string>): ReadonlySet<string> => {
  const treeKey = useGlobalSessionsStore(React.useCallback((state) => (
    workingSessionIds.size === 0
      ? ''
      : sessionsInTree(workingSessionIds, sessionId, (id) => state.entityById.get(id)?.parentID ?? undefined).join('\n')
  ), [sessionId, workingSessionIds]));
  return React.useMemo(() => new Set(treeKey ? treeKey.split('\n') : []), [treeKey]);
};

/** A command still running, or one that ended and keeps its row until dismissed. */
type ShellRowItem =
  | { kind: 'running'; shell: TrackedShell }
  | { kind: 'ended'; shell: EndedShell };

/**
 * Commands of this session and of its subagents, running or ended, in the
 * order they started, so a command keeps its row when it ends.
 */
const useSessionTreeShells = (sessionId: string): ShellRowItem[] => {
  const runningSessionIds = useBackgroundShellsStore((state) => state.sessionIds);
  const endedSessionIds = useBackgroundShellsStore((state) => state.endedSessionIds);
  const candidateIds = React.useMemo(
    () => (endedSessionIds.size === 0 ? runningSessionIds : new Set([...runningSessionIds, ...endedSessionIds])),
    [endedSessionIds, runningSessionIds],
  );
  const treeIds = useTreeIds(sessionId, candidateIds);
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

const useSessionTreeImages = (sessionId: string): RunningImageJob[] => {
  const treeIds = useTreeIds(sessionId, useBackgroundImagesStore((state) => state.sessionIds));
  return useBackgroundImagesStore(useShallow(React.useCallback((state) => (
    treeIds.size === 0 ? [] : backgroundImagesOfSessions(state.byId, treeIds)
  ), [treeIds])));
};

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

const useStopShells = (rootSessionId: string, rootDirectory: string | undefined) => {
  const { t } = useI18n();
  const [stoppingIds, setStoppingIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const stop = React.useCallback((shells: readonly TrackedShell[]) => {
    const pending = shells.filter((shell) => !stoppingIds.has(shell.id) && !isForegroundShellStopping(shell.id));
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
  const stoppingFromRow = useForegroundShellStopping(shell.id);

  return (
    <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
      <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
      <Tooltip delayDuration={COMMAND_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate font-mono typography-code text-foreground">
            {shell.command}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[min(36rem,90vw)] [text-wrap:wrap]">
          <ScrollableOverlay as="pre" outerClassName="max-h-[50vh]" className="whitespace-pre-wrap break-words font-mono typography-code" disableHorizontal>
            {shell.command}
          </ScrollableOverlay>
        </TooltipContent>
      </Tooltip>
      {fromSubagent ? (
        <span className="shrink-0 typography-meta text-muted-foreground">{t('chat.backgroundShells.subagent')}</span>
      ) : null}
      {item.kind === 'running' ? (
        <>
          <ShellElapsed startedAt={shell.startedAt} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={stopping || stoppingFromRow}
                  onClick={() => onStop(item.shell)}
                  onMouseDown={(event) => event.preventDefault()}
                  aria-label={t('chat.backgroundShells.stopAria', { command: shell.command })}
                  className={STOP_BUTTON_CLASS}
                >
                  {t('chat.backgroundShells.stop')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('contextTooltips.chat.shellStop')}</TooltipContent>
          </Tooltip>
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

const imageName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const ImageRow: React.FC<{ job: RunningImageJob; fromSubagent: boolean }> = ({ job, fromSubagent }) => {
  const { t } = useI18n();

  return (
    <div className="flex oc-composer-row items-center gap-2 ps-3 pe-3">
      <Icon name="image" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 typography-ui-label text-foreground">{t('chat.backgroundImages.generating')}</span>
      <Tooltip delayDuration={COMMAND_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate font-mono typography-code text-muted-foreground">
            {imageName(job.path)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[min(36rem,90vw)] break-words">
          <div className="font-mono typography-code">{job.path}</div>
          <div className="typography-meta text-muted-foreground">{job.model}</div>
        </TooltipContent>
      </Tooltip>
      {fromSubagent ? (
        <span className="shrink-0 typography-meta text-muted-foreground">{t('chat.backgroundShells.subagent')}</span>
      ) : null}
      <ShellElapsed startedAt={job.startedAt} />
    </div>
  );
};

export const BackgroundShellsStrip: React.FC<BackgroundShellsStripProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const shellRows = useSessionTreeShells(sessionId ?? '');
  const images = useSessionTreeImages(sessionId ?? '');
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const { stoppingIds, stop } = useStopShells(sessionId ?? '', directory);
  const stopOne = React.useCallback((shell: TrackedShell) => stop([shell]), [stop]);
  const foregroundStoppingIds = useForegroundShellStoppingIds();

  const count = shellRows.length + images.length;
  if (!sessionId || count === 0) return null;

  const shells: TrackedShell[] = [];
  const endedIds: string[] = [];
  for (const item of shellRows) {
    if (item.kind === 'running') shells.push(item.shell);
    else endedIds.push(item.shell.id);
  }

  const ariaLabel = images.length === 0 ? t('chat.backgroundShells.aria') : t('chat.backgroundWork.aria');
  const rows = [
    ...shellRows.map((item) => (
      <ShellRow
        key={item.shell.id}
        item={item}
        fromSubagent={item.shell.sessionID !== sessionId}
        stopping={stoppingIds.has(item.shell.id)}
        onStop={stopOne}
      />
    )),
    ...images.map((job) => <ImageRow key={job.id} job={job} fromSubagent={job.sessionID !== sessionId} />),
  ];

  if (count === 1) {
    return (
      <div role="group" className="border-b border-edge" aria-label={ariaLabel}>
        {rows}
      </div>
    );
  }

  return (
    <div role="group" className="border-b border-edge" aria-label={ariaLabel}>
      <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
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
              <Icon name={shellRows.length === 0 ? 'image' : 'terminal-box'} className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-start">
                {images.length === 0
                  ? t('chat.backgroundShells.count', { count })
                  : t('chat.backgroundWork.count', { count })}
              </span>
              <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t(expanded ? 'contextTooltips.chat.shellsHide' : 'contextTooltips.chat.shellsShow')}</TooltipContent>
        </Tooltip>
        {shells.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={shells.every((shell) => stoppingIds.has(shell.id) || foregroundStoppingIds.has(shell.id))}
                  onClick={() => stop(shells)}
                  onMouseDown={(event) => event.preventDefault()}
                  className={STOP_BUTTON_CLASS}
                >
                  {t('chat.backgroundShells.stopAll')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('contextTooltips.chat.shellStopAll')}</TooltipContent>
          </Tooltip>
        ) : endedIds.length > 0 ? (
          // Once no command runs, the header dismisses the ended ones.
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
        ) : null}
      </div>
      {expanded ? (
        // Four rows, then the list scrolls, so ended commands kept for their
        // status cannot push the editor off a short screen.
        <div id={listId} className="max-h-40 overflow-y-auto overscroll-contain">
          {rows}
        </div>
      ) : null}
    </div>
  );
});

BackgroundShellsStrip.displayName = 'BackgroundShellsStrip';
