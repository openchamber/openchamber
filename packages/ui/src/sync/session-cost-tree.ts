import type { Session } from "@/lib/opencode/model"
import type { SessionTree } from "@/components/chat/work-status/subagentCost"

type SessionSlice = readonly Session[]

type SliceMembership = {
  slice: SessionSlice
  positionById: ReadonlyMap<string, number>
  childIdsByParent: ReadonlyMap<string, readonly string[]>
}

const membershipByDirectory = new Map<string, SliceMembership>()
let membershipBuilds = 0

export const countSessionCostMembershipBuilds = (): number => membershipBuilds

const sameMembership = (previous: SessionSlice, next: SessionSlice): boolean => {
  if (previous.length !== next.length) return false
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (before === after) continue
    if (
      before.id !== after.id
      || before.parentID !== after.parentID
      || Boolean(before.time?.archived) !== Boolean(after.time?.archived)
    ) return false
  }
  return true
}

const buildMembership = (slice: SessionSlice): SliceMembership => {
  membershipBuilds += 1
  const positionById = new Map<string, number>()
  const childIdsByParent = new Map<string, string[]>()
  slice.forEach((session, position) => {
    positionById.set(session.id, position)
    if (!session.parentID || session.time?.archived) return
    const siblings = childIdsByParent.get(session.parentID)
    if (siblings) siblings.push(session.id)
    else childIdsByParent.set(session.parentID, [session.id])
  })
  return { slice, positionById, childIdsByParent }
}

const readMembership = (directory: string, slice: SessionSlice): SliceMembership => {
  const cached = membershipByDirectory.get(directory)
  if (cached?.slice === slice) return cached
  const next = cached && sameMembership(cached.slice, slice)
    ? { ...cached, slice }
    : buildMembership(slice)
  membershipByDirectory.set(directory, next)
  return next
}

export const withDirectorySessions = (
  global: SessionTree,
  isListed: (sessionId: string) => boolean,
  slices: Iterable<readonly [string, SessionSlice]>,
  liveCost?: ReadonlyMap<string, number>,
): SessionTree => {
  const memberships: SliceMembership[] = []
  for (const [directory, slice] of slices) memberships.push(readMembership(directory, slice))
  return {
    readSession: (sessionId) => {
      const listed = global.readSession(sessionId)
      if (listed) return listed
      for (const membership of memberships) {
        const position = membership.positionById.get(sessionId)
        if (position === undefined) continue
        const session = membership.slice[position]
        const cost = liveCost?.get(sessionId)
        return cost === undefined ? session : { ...session, cost }
      }
      return undefined
    },
    childIdsOf: (sessionId) => {
      const listed = global.childIdsOf(sessionId)
      let unlisted: string[] | undefined
      for (const membership of memberships) {
        for (const childId of membership.childIdsByParent.get(sessionId) ?? []) {
          if (isListed(childId) || listed?.includes(childId) || unlisted?.includes(childId)) continue
          ;(unlisted ??= []).push(childId)
        }
      }
      if (!unlisted) return listed
      return listed ? [...listed, ...unlisted] : unlisted
    },
  }
}

export const readDirectorySession = (
  sessionId: string,
  slices: Iterable<readonly [string, SessionSlice]>,
): Session | undefined => {
  for (const [directory, slice] of slices) {
    const membership = readMembership(directory, slice)
    const position = membership.positionById.get(sessionId)
    if (position !== undefined) return slice[position]
  }
  return undefined
}
