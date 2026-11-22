import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { isOperatorChildSession, metadataAfterTakeOver, permissionsAfterTakeOver } from '@/lib/sessionOperatorChild';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { patchSessionMetadata } from './session-actions';

export const takeOverSession = async (sessionId: string, directory: string | null): Promise<Session | null> => {
  const runtimeKeyAtClick = getRuntimeKey();
  try {
    const current = await opencodeClient.getSession(sessionId, directory);
    if (getRuntimeKey() !== runtimeKeyAtClick) return null;
    if (!isOperatorChildSession(current)) return current;
    await opencodeClient.setSessionPermissions(sessionId, permissionsAfterTakeOver(current.permissions), directory);
    return await patchSessionMetadata(sessionId, directory, (metadata) => metadataAfterTakeOver(metadata, Date.now()), runtimeKeyAtClick);
  } catch (error) {
    if (getRuntimeKey() !== runtimeKeyAtClick) return null;
    throw error;
  }
};

export const takeOverSessions = async (sessions: readonly Session[], directoryOf: (session: Session) => string | null): Promise<string[]> => {
  const failed: string[] = [];
  const runtimeKey = getRuntimeKey();
  for (const session of sessions) {
    if (getRuntimeKey() !== runtimeKey) break;
    try {
      await takeOverSession(session.id, directoryOf(session));
    } catch {
      failed.push(session.id);
    }
  }
  return failed;
};
