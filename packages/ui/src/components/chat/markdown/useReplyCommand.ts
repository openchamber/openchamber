import React from 'react';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { awaitsContinuation, findReplyCommandRun, type ReplyCommandRun } from '@/lib/opencode/reply-command';
import type { Message } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useRunningShell } from '@/sync/background-shells';
import { continueFromReplyCommand, runReplyCommand } from '@/sync/reply-commands';
import { useSessionMessagesSelector } from '@/sync/sync-context';

type Reply = { sessionId: string; messageId: string };

export type ReplyCommand = {
  run: ReplyCommandRun | null;
  starting: boolean;
  running: boolean;
  start: () => void;
  stop: () => void;
};

const sameRun = (left: ReplyCommandRun | null, right: ReplyCommandRun | null): boolean => (
  left === right || (
    left !== null && right !== null
    && left.shell === right.shell
    && left.continued === right.continued
    && left.completion?.shellID === right.completion?.shellID
  )
);

/** The run button and result of a command block in a finished reply. */
export function useReplyCommand(reply: Reply, directory: string, command: string): ReplyCommand {
  const { t } = useI18n();
  const { sessionId, messageId } = reply;
  const select = React.useCallback(
    (messages: Message[]) => findReplyCommandRun(messages, messageId, command),
    [command, messageId],
  );
  const run = useSessionMessagesSelector(sessionId, directory, select, sameRun);
  const running = run?.shell.status === 'running';
  const shell = useRunningShell(running ? run.shell.shellID : undefined);
  const [startingFrom, setStartingFrom] = React.useState<string | null | undefined>(undefined);
  // Starting ends when the transcript shows a run newer than the one before the click.
  const starting = startingFrom !== undefined && startingFrom === (run?.shell.id ?? null);

  // A run the client that started it no longer watches, such as after a reload.
  const note = run?.note;
  const owed = run ? awaitsContinuation(run) : false;
  React.useEffect(() => {
    if (owed && note) continueFromReplyCommand(note, { runtimeKey: getRuntimeKey(), sessionId, directory });
  }, [directory, note, owed, sessionId]);

  return {
    run,
    starting,
    running,
    start: () => {
      setStartingFrom(run?.shell.id ?? null);
      runReplyCommand({ sessionId, directory, replyMessageID: messageId, command }).catch((error) => {
        setStartingFrom(undefined);
        toast.error(t('markdownRenderer.code.run.startFailed'), {
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    stop: () => {
      if (!run) return;
      opencodeClient.stopBackgroundShells({
        sessionID: sessionId,
        sessionDirectory: directory,
        shells: [{ shellID: run.shell.shellID, shellDirectory: shell?.directory ?? directory, command }],
      }).catch(() => toast.error(t('chat.toolPart.background.stopFailed')));
    },
  };
}
