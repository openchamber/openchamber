import { opencodeClient } from '@/lib/opencode/client';
import type { ModelRef, Session } from '@/lib/opencode/model';
import { requestSessionMetadataUpdate } from '@/sync/session-archive-batch';
import { getMultiRunMembership, multiRunMembershipPatch, withMultiRunMembership, type MultiRunIdentity } from './identity';

/** Bind the server-assigned ID before dispatch. A fork inherits this ID and cannot join. */
export async function createMultiRunSession(
  input: {
    title: string;
    directory: string;
    identity: Omit<MultiRunIdentity, 'key'>;
    /** Model and agent the run is pinned to; v2 sets them on the session, not per prompt. */
    selection?: { model?: ModelRef; agent?: string };
  },
  assertCurrent: () => void,
): Promise<Session> {
  assertCurrent();
  const membership = { ...input.identity, version: 1 as const, sessionID: null };
  const session = await opencodeClient.createSession({
    title: input.title,
    model: input.selection?.model,
    agent: input.selection?.agent,
    metadata: withMultiRunMembership({}, membership),
  }, input.directory);
  try {
    assertCurrent();
    // OpenCode 2.x takes metadata only at creation, so the ID is bound through
    // OpenChamber's own metadata route. It applies an RFC 7386 merge patch, so
    // only the marker travels and nothing another feature wrote under
    // `openchamber` in the meantime is replaced — no read-modify-write needed.
    const result = await requestSessionMetadataUpdate(
      session.id,
      multiRunMembershipPatch({ ...membership, sessionID: session.id }),
    );
    assertCurrent();
    if (result.outcome !== 'updated') throw new Error(`Multi-run membership was not saved: ${result.reason}`);
    const bound: Session = { ...session, metadata: result.metadata };
    if (!getMultiRunMembership(bound)) throw new Error('Multi-run membership was not saved');
    return bound;
  } catch (error) {
    // Never delete through a switched runtime. The pending marker remains ineligible.
    assertCurrent();
    try {
      await opencodeClient.deleteSession(session.id, input.directory);
    } catch {
      console.warn('[MultiRun] Could not remove an undispatched session after membership failure');
    }
    throw error;
  }
}
