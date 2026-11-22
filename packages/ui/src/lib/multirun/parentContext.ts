import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getMultiRunIdentity, type MultiRunIdentity } from './identity';
import type { loadLaneLastReply } from './laneData';

type ParentContextEffects = {
  readSession: typeof opencodeClient.getSession;
  readReply: typeof loadLaneLastReply;
  isBusy: (id: string) => boolean;
  blocking: (id: string) => 'permission' | 'question' | null;
};
type ParentMemberSnapshot = {
  state: 'ready'; sessionID: string; directory: string; title: string;
  role: MultiRunIdentity['role'];
  status: 'permission' | 'question' | 'working' | 'succeeded' | 'failed' | 'interrupted' | 'finished' | 'not started';
  latestResult?: string; fusionGuidance?: string;
} | { state: 'unavailable'; sessionID: string; directory: string };

/** Current known membership is revalidated when the user messages the parent. */
export async function buildRunParentContext(
  input: { parent: Session; sessions: Iterable<Session> },
  io: ParentContextEffects,
): Promise<string> {
  const identity = getMultiRunIdentity(input.parent);
  if (identity?.role !== 'parent') return '';
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const current = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const candidates = [...input.sessions].filter((session) => !session.time.archived && !session.parentID
    && session.id !== input.parent.id && getMultiRunIdentity(session)?.key === identity.key);
  const members: ParentMemberSnapshot[] = [];
  for (const cached of candidates) {
    try {
      const session = await io.readSession(cached.id, cached.directory);
      current();
      const memberIdentity = getMultiRunIdentity(session);
      if (session.time.archived || !memberIdentity || memberIdentity.key !== identity.key) continue;
      const blocking = io.blocking(session.id);
      const busy = io.isBusy(session.id);
      const reply = busy ? undefined : await io.readReply(session.id, session.directory);
      current();
      members.push({ state: 'ready', sessionID: session.id, directory: session.directory, title: session.title,
        role: memberIdentity.role, status: blocking ?? (busy ? 'working' : session.outcome ?? (session.time.idle ? 'finished' : 'not started')),
        latestResult: reply, fusionGuidance: memberIdentity.guidance });
    } catch {
      current();
      members.push({ state: 'unavailable', sessionID: cached.id, directory: cached.directory });
    }
  }
  return [
    'You are the parent conversation for this multi-model run. Answer progress questions, compare available results, and help refine instructions.',
    'User messages here guide this conversation and subsequent fusion passes. They are not automatically delivered to individual model sessions. To change a member\'s ongoing work, ask the user to open that session and send the instruction there. Completed work changes only after another instruction runs.',
    'Keep source conversations, worktrees, files, and results intact. Do not apply changes to their directories or perform cleanup. Report unavailable results as unavailable.',
    `Current known members, read for this user message: ${JSON.stringify(members)}`,
  ].join('\n\n');
}
