import { readShellCompletion } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';
import { ascendingId } from '@/lib/opencode/ids';
import { replyCommandContinuation, replyCommandNote, type ReplyCommandNote } from '@/lib/opencode/reply-command';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { commitStagedRevert } from './session-actions';

type Target = { runtimeKey: string; sessionId: string; directory: string };
type WatchedRun = { note: ReplyCommandNote; target: Target; shellID?: string };

const watched = new Map<string, WatchedRun>();
const continuing = new Set<string>();

export const continueFromReplyCommand = (note: ReplyCommandNote, target: Target): void => {
  if (continuing.has(note.continuationID)) return;
  continuing.add(note.continuationID);
  opencodeClient.resumeWithSyntheticInput({
    ...replyCommandContinuation(note),
    runtimeKey: target.runtimeKey,
    id: note.continuationID,
    sessionId: target.sessionId,
    directory: target.directory,
  }).catch((error) => {
    continuing.delete(note.continuationID);
    console.warn('[reply-command] agent not continued:', error);
  });
};

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
  await commitStagedRevert(params.sessionId, params.directory);
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
