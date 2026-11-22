import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { requestSessionMetadataUpdate } from '@/sync/session-archive-batch';
import { getMultiRunIdentity, multiRunMembershipPatch, RUN_GUIDANCE_LIMIT } from './identity';
import type { MultiRunSummary } from './runs';
import { z } from 'zod';
import { resolveGitPrimaryRoot } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';

const openchamberSchema = z.record(z.string(), z.json());

/** Unknown, future, or inherited markers are not permission to overwrite them. */
export function canAttachSession(session: Session): boolean {
  if (session.time.archived || session.parentID || !session.model) return false;
  const metadata = openchamberSchema.safeParse(session.metadata?.openchamber);
  if (metadata.success && Object.hasOwn(metadata.data, 'multirun')) return false;
  return getMultiRunIdentity(session) === null;
}

type MembershipEffects = {
  read: typeof opencodeClient.getSession;
  write: typeof requestSessionMetadataUpdate;
  publish: typeof registerMultiRunSession;
  primaryRoot: typeof resolveGitPrimaryRoot;
};

const effects: MembershipEffects = {
  read: (id, directory) => opencodeClient.getSession(id, directory),
  write: requestSessionMetadataUpdate,
  publish: registerMultiRunSession,
  primaryRoot: resolveGitPrimaryRoot,
};

/** Adds existing work without moving its directory or rerunning its prompt. */
export async function attachSessionToRun(
  input: { run: MultiRunSummary; session: Session; anchor: Session },
  io: MembershipEffects = effects,
): Promise<Session> {
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const [session, anchor] = await Promise.all([
    io.read(input.session.id, input.session.directory),
    io.read(input.anchor.id, input.anchor.directory),
  ]);
  assertCurrent();
  const target = getMultiRunIdentity(anchor);
  if (!target || target.key !== input.run.key || anchor.time.archived || anchor.parentID) throw new Error('Run membership changed');
  if (target.group.kind !== 'id') throw new Error('Existing sessions can only join ID-bound runs');
  if (session.time.archived || session.parentID) throw new Error('Session must be an active root');
  const existing = getMultiRunIdentity(session);
  if (existing?.key === target.key) return session;
  if (existing) throw new Error('Detach the session from its current run first');
  if (!canAttachSession(session)) throw new Error('Session membership is not eligible for import');
  if (!session.model) throw new Error('Session has no model');
  if (normalizePath(session.directory) !== normalizePath(anchor.directory)) {
    // Native project IDs can reflect a location warmed before checkout. Use
    // the actual repository root when importing from another directory.
    const [sourceRoot, targetRoot] = await Promise.all([io.primaryRoot(session.directory), io.primaryRoot(anchor.directory)]);
    assertCurrent();
    if (normalizePath(sourceRoot) !== normalizePath(targetRoot)) throw new Error('Session belongs to another project');
  }

  // An imported conversation has its own original prompt. Giving it a new
  // variant keeps the overview caption and fusion task matched to that prompt.
  const rank = Math.max(1, ...input.run.variants.map((variant) => variant ? Number(variant.slice(1)) : 1));
  const result = await io.write(session.id, multiRunMembershipPatch({
    version: 1, sessionID: session.id,
    group: target.group, groupSlug: target.groupSlug, title: input.run.title,
    runGroup: `g${rank + 1}`, providerID: session.model.providerID, modelID: session.model.id, role: 'run',
  }), session.directory);
  assertCurrent();
  if (result.outcome !== 'updated') throw new Error(`Membership was not saved: ${result.reason}`);
  const bound = { ...session, metadata: result.metadata };
  if (getMultiRunIdentity(bound)?.key !== target.key) throw new Error('Membership was not saved');
  return io.publish(bound, bound.directory);
}

/** Cancellation performs no read, write, navigation, archive, or file operation. */
export async function detachSessionFromRun(
  input: { session: Session; runKey: string; confirmed: boolean; legacyDirectory?: string },
  io: MembershipEffects = effects,
): Promise<boolean> {
  if (!input.confirmed) return false;
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const session = await io.read(input.session.id, input.session.directory);
  assertCurrent();
  if (getMultiRunIdentity(session, input.legacyDirectory)?.key !== input.runKey) throw new Error('Run membership changed');
  // The flag prevents old slash-style titles from restoring legacy membership
  // after the RFC 7386 patch removes the marker. The conversation title stays.
  const result = await io.write(session.id, { openchamber: { multirun: null, multirunDetached: true } }, session.directory);
  assertCurrent();
  if (result.outcome !== 'updated') throw new Error(`Membership was not removed: ${result.reason}`);
  const detached = { ...session, metadata: result.metadata };
  if (getMultiRunIdentity(detached)) throw new Error('Membership was not removed');
  io.publish(detached, detached.directory);
  return true;
}

/** Save user preferences on the source, so revisiting the overview keeps them. */
export async function saveFusionGuidance(
  input: { session: Session; runKey: string; guidance: string; legacyDirectory?: string },
  io: MembershipEffects = effects,
): Promise<void> {
  const guidance = input.guidance.trim();
  if (guidance.length > RUN_GUIDANCE_LIMIT) throw new Error('Guidance is too long');
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const current = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const session = await io.read(input.session.id, input.session.directory);
  current();
  const identity = getMultiRunIdentity(session, input.legacyDirectory);
  if (!identity || identity.key !== input.runKey || session.time.archived) throw new Error('Run membership changed');
  if (identity.group.kind === 'legacy' && identity.role === 'run') throw new Error('Saved guidance requires ID-bound membership');
  const result = await io.write(session.id, { openchamber: { multirun: { guidance } } }, session.directory);
  current();
  if (result.outcome !== 'updated') throw new Error(`Guidance was not saved: ${result.reason}`);
  const updated = { ...session, metadata: result.metadata };
  if (getMultiRunIdentity(updated)?.guidance !== guidance) throw new Error('Guidance was not saved');
  io.publish(updated, updated.directory);
}
