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
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import {
  sessionsInTree,
  backgroundShellsOfSessions,
  useBackgroundShellsStore,
  type TrackedShell,
} from '@/sync/background-shells';

interface BackgroundShellsStripProps {
  sessionId: string | null;
  directory?: string;
}

const ELAPSED_TICK_MS = 1000;
const COMMAND_TOOLTIP_DELAY_MS = 500;

/**
 * Commands of this session and of its subagents. The tree is resolved only
 * for sessions that run something, and the result is compared as a string, so
 * the session list changing during a stream re-renders nothing here.
 */
const useSessionTreeShells = (sessionId: string): TrackedShell[] => {
  const shellSessionIds = useBackgroundShellsStore((state) => state.sessionIds);
  const treeKey = useGlobalSessionsStore(React.useCallback((state) => (
    shellSessionIds.size === 0
      ? ''
      : sessionsInTree(shellSessionIds, sessionId, (id) => state.entityById.get(id)?.parentID ?? undefined).join('\n')
  ), [sessionId, shellSessionIds]));
  const treeIds = React.useMemo(() => new Set(treeKey ? treeKey.split('\n') : []), [treeKey]);
  return useBackgroundShellsStore(useShallow(React.useCallback((state) => (
    treeIds.size === 0 ? [] : backgroundShellsOfSessions(state.byId, treeIds)
  ), [treeIds])));
};

/** Its own leaf, so the once-a-second tick re-renders this text alone. */
const ShellElapsed: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const { t } = useI18n();
  const now = useDurationTickerNow(true, ELAPSED_TICK_MS);
  const label = formatSessionActivityDuration(now - startedAt, t);
  return (
    <span className="shrink-0 typography-meta tabular-nums text-muted-foreground" title={t('chat.backgroundShells.elapsed', { duration: label })}>
      {label}
    </span>
  );
};

const ShellRow: React.FC<{ shell: TrackedShell; rootSessionId: string; rootDirectory?: string }> = ({ shell, rootSessionId, rootDirectory }) => {
  const { t } = useI18n();
  const [stopping, setStopping] = React.useState(false);
  const fromSubagent = shell.sessionID !== rootSessionId;

  // The same stop the command's row in the chat offers: the agent is told
  // first, then the command is removed. The row leaves when OpenCode reports
  // the command ended.
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    const sessionDirectory = fromSubagent
      ? useGlobalSessionsStore.getState().entityById.get(shell.sessionID)?.directory ?? shell.directory
      : rootDirectory;
    opencodeClient.stopBackgroundShell({
      sessionID: shell.sessionID,
      sessionDirectory,
      shellID: shell.id,
      shellDirectory: shell.directory,
      command: shell.command,
    }).catch(() => {
      setStopping(false);
      toast.error(t('chat.toolPart.background.stopFailed'));
    });
  };

  return (
    <div className="flex h-10 items-center gap-2 pl-3 pr-1.5">
      <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
      <Tooltip delayDuration={COMMAND_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground">
            {shell.command}
          </span>
        </TooltipTrigger>
        {/* The row shows one truncated line; the tooltip keeps the command's
            own line breaks and indentation and wraps only overlong lines. */}
        <TooltipContent side="top" sideOffset={6} className="max-w-[min(36rem,90vw)] [text-wrap:wrap]">
          <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-mono typography-meta">
            {shell.command}
          </pre>
        </TooltipContent>
      </Tooltip>
      {fromSubagent ? (
        <span className="shrink-0 typography-meta text-muted-foreground">{t('chat.backgroundShells.subagent')}</span>
      ) : null}
      <ShellElapsed startedAt={shell.startedAt} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={stopping}
        onClick={stop}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={t('chat.backgroundShells.stopAria', { command: shell.command })}
        className="shrink-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
      >
        {t('chat.backgroundShells.stop')}
      </Button>
    </div>
  );
};

/**
 * Commands the agent left running in the background (dev servers, watchers,
 * test pages), as a top row of the composer next to the "looks done" hint.
 * One command is its own row; several collapse into a count that expands in
 * place, so the composer grows by one row unless the user asks for the list.
 */
export const BackgroundShellsStrip: React.FC<BackgroundShellsStripProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const shells = useSessionTreeShells(sessionId ?? '');
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();

  if (!sessionId || shells.length === 0) return null;

  if (shells.length === 1) {
    return (
      <div role="group" className="border-b border-border/60" aria-label={t('chat.backgroundShells.aria')}>
        <ShellRow shell={shells[0]} rootSessionId={sessionId} rootDirectory={directory} />
      </div>
    );
  }

  // The whole header toggles the list, as the queue header does.
  return (
    <div role="group" className="border-b border-border/60" aria-label={t('chat.backgroundShells.aria')}>
      <div className="flex h-10 items-center pl-3 pr-3">
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
          <span className="min-w-0 flex-1 truncate text-left">
            {t('chat.backgroundShells.count', { count: shells.length })}
          </span>
          <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </div>
      {expanded ? (
        <div id={listId}>
          {shells.map((shell) => (
            <ShellRow key={shell.id} shell={shell} rootSessionId={sessionId} rootDirectory={directory} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

BackgroundShellsStrip.displayName = 'BackgroundShellsStrip';
