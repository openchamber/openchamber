import type { Session } from '@/lib/opencode/model'

/**
 * Whether an archived session can be restored by itself. A top-level session
 * always can. A subsession can only while its parent is known and active: one
 * under an archived parent comes back with that parent, so an agent run is
 * restored whole. The Archive page lists exactly these sessions, the session
 * menu offers Restore for them, and `restoreSessionTree` refuses the rest.
 */
export const isRestorableOnItsOwn = (session: Session, entityById: ReadonlyMap<string, Session>): boolean => {
  if (!session.parentID) return true
  const parent = entityById.get(session.parentID)
  return Boolean(parent && !parent.time?.archived)
}
