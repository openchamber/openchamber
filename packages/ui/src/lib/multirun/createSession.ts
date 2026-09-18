import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { getMultiRunMembership, withMultiRunMembership, type MultiRunIdentity } from './identity';

/** Bind the server-assigned ID before dispatch. A fork inherits this ID and cannot join. */
export async function createMultiRunSession(
  client: OpencodeClient,
  input: { title: string; directory: string; identity: Omit<MultiRunIdentity, 'key'> },
  assertCurrent: () => void,
): Promise<Session> {
  assertCurrent();
  const membership = { ...input.identity, version: 1 as const, sessionID: null };
  const created = await client.session.create({
    directory: input.directory, title: input.title,
    metadata: withMultiRunMembership({}, membership),
  }, { throwOnError: true });
  if (!created.data) throw new Error('Multi-run session creation returned no session');
  const session = created.data;
  try {
    assertCurrent();
    // Metadata updates replace the whole object. Preserve fields written since creation.
    const current = await client.session.get({ sessionID: session.id, directory: input.directory }, { throwOnError: true });
    if (!current.data) throw new Error('Multi-run session could not be read');
    assertCurrent();
    const updated = await client.session.update({
      sessionID: session.id, directory: input.directory,
      metadata: withMultiRunMembership(current.data, { ...membership, sessionID: session.id }),
    }, { throwOnError: true });
    assertCurrent();
    if (!updated.data || !getMultiRunMembership(updated.data)) throw new Error('Multi-run membership was not saved');
    return updated.data;
  } catch (error) {
    // Never delete through a switched runtime. The pending marker remains ineligible.
    assertCurrent();
    try {
      await client.session.delete({ sessionID: session.id, directory: input.directory }, { throwOnError: true });
    } catch {
      console.warn('[MultiRun] Could not remove an undispatched session after membership failure');
    }
    throw error;
  }
}
