import { readShellCompletion } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';
import { ascendingId } from '@/lib/opencode/ids';
import { replyCommandContinuation, replyCommandNote, type ReplyCommandNote } from '@/lib/opencode/reply-command';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Runs started by this client, watched from the event stream: the block that
// started one may scroll away or its session may close before the command
// ends, and the agent still has to continue. A run that outlives this client
// is continued by its block when the session is opened again.
type Target = { runtimeKey: string; sessionId: string; directory: string };
type WatchedRun = { note: ReplyCommandNote; target: Target; shellID?: string };

const watched = new Map<string, WatchedRun>();
// A block and the event stream both see a command end.
const continuing = new Set<string>();

export const continueFromReplyCommand = (note: ReplyCommandNote, target: Target): void => {
  if (continuing.has(note.continuationID)) return;
  continuing.add(note.continuationID);
  opencodeClient.resumeWithSyntheticInput({
    ...replyCommandContinuation(note),
    runtimeKey: target.runtimeKey,
    // Fixed at the run, so a second client watching the session is refused
    // as a repeat instead of waking the agent twice.
    id: note.continuationID,
    sessionId: target.sessionId,
    directory: target.directory,
  }).catch((error) => {
    continuing.delete(note.continuationID);
    console.warn('[reply-command] agent not continued:', error);
  });
};

/**
 * Runs a command from a block of the agent's reply. Rejects when the command
 * did not start. OpenCode answers the shell request only when the command
 * ends, so a request lost after the start is no failure: the events carry the
 * rest.
 */
export const runReplyCommand = async (params: {
  sessionId: string;
  directory: string;
  replyMessageID: string;
  command: string;
}): Promise<void> => {
  const target = { runtimeKey: getRuntimeKey(), sessionId: params.sessionId, directory: params.directory };
  const note: ReplyCommandNote = {
    replyMessageID: params.replyMessageID,
    command: params.command,
    shellMessageID: ascendingId('msg'),
    continuationID: ascendingId('msg'),
  };
  await opencodeClient.addSessionNote({ ...replyCommandNote(note), ...target });
  const run: WatchedRun = { note, target };
  watched.set(note.shellMessageID, run);
  try {
    await opencodeClient.shellSession({ ...target, command: params.command, messageId: note.shellMessageID });
  } catch (error) {
    if (run.shellID !== undefined) return;
    watched.delete(note.shellMessageID);
    throw error;
  }
};

export const applyReplyCommandEvents = (payloads: readonly SyncEvent[]): void => {
  if (watched.size === 0) return;
  for (const payload of payloads) {
    if (payload.type !== 'message.updated') continue;
    const { info } = payload.properties;
    if (info.role === 'shell') {
      const run = watched.get(info.id);
      if (run) run.shellID = info.shellID;
      continue;
    }
    const completion = readShellCompletion(info);
    if (!completion) continue;
    for (const [id, run] of watched) {
      if (run.shellID !== completion.shellID) continue;
      watched.delete(id);
      if (completion.state !== 'cancelled') continueFromReplyCommand(run.note, run.target);
      break;
    }
  }
};
