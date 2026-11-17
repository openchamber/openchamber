import type { Session } from '@/lib/opencode/model'

export const isRestorableOnItsOwn = (session: Session, entityById: ReadonlyMap<string, Session>): boolean => {
  if (!session.parentID) return true
  const parent = entityById.get(session.parentID)
  return Boolean(parent && !parent.time?.archived)
}
