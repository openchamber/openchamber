import type { OpenCodeClient } from "@opencode/client"
import { normalizePath } from "@/lib/pathNormalization"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { isOpencodeNotFound, normalizeOpencodeError, opencodeClient } from "./client"
import { activeSessionSnapshotSchema } from "./session-status"

type RunningJobOwners = { sessionID: string; childSessionID?: string }

export type LocationWorkReads = {
  activeSessionIDs: () => Promise<readonly string[]>
  runningJobs: () => Promise<readonly RunningJobOwners[]>
  sessionDirectory: (sessionID: string) => Promise<string | null>
}

export async function isLocationBusy(directory: string, reads: LocationWorkReads): Promise<boolean | null> {
  const target = normalizePath(directory)
  if (!target) return null
  try {
    const [active, jobs] = await Promise.all([reads.activeSessionIDs(), reads.runningJobs()])
    const owners = new Set(active)
    for (const job of jobs) {
      owners.add(job.sessionID)
      if (job.childSessionID) owners.add(job.childSessionID)
    }
    const directories = await Promise.all([...owners].map((sessionID) => reads.sessionDirectory(sessionID)))
    return directories.some((owner) => owner !== null && normalizePath(owner) === target)
  } catch {
    return null
  }
}

async function orWhenMissing<T>(operation: string, read: () => Promise<T>, missing: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (isOpencodeNotFound(normalizeOpencodeError(operation, error))) return missing
    throw error
  }
}

const sdkReads = (client: OpenCodeClient): LocationWorkReads => ({
  activeSessionIDs: async () => Object.keys(activeSessionSnapshotSchema.parse(await client.session.active())),
  runningJobs: () => orWhenMissing("job.list", async () => {
    const jobs = await client.experimental.job.list({ status: "running" })
    return jobs.map((job): RunningJobOwners => (job.kind === "subagent" ? { sessionID: job.sessionID, childSessionID: job.childSessionID } : { sessionID: job.sessionID }))
  }, []),
  sessionDirectory: (sessionID) => orWhenMissing<string | null>("session.get", async () => (await client.session.get({ sessionID })).location.directory, null),
})

export function isLocationBusyOnServer(directory: string): Promise<boolean | null> {
  const client = isSpaceDirectory(directory) ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()
  return isLocationBusy(directory, sdkReads(client))
}
