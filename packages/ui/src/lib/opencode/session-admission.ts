import { normalizePath } from "@/lib/pathNormalization"

const PARTICIPATING_REPOSITORY_ROOTS = [
  "/Users/hugolloyd/Dev/Github/kinnectApp",
  "/Users/hugolloyd/Dev/Github/kinnectAppBackend",
  "/Users/hugolloyd/Dev/Github/kinnectAppWebsite",
  "/Users/hugolloyd/Dev/Github/kinnect-ops-console",
  "/Users/hugolloyd/Dev/Github/kinnect-machine",
  "/Users/hugolloyd/Dev/Github/kinnect-governance",
  "/Users/hugolloyd/Dev/Github/kinnectApp-home-stacked",
] as const

const canonicalizeDirectory = (directory: string | null | undefined): string | null => {
  const normalized = normalizePath(directory)
  if (normalized === null) return null

  const isAbsolute = normalized.startsWith("/")
  const segments = normalized.split("/")
  const canonicalSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === ".." && canonicalSegments.at(-1) !== undefined && canonicalSegments.at(-1) !== "..") {
      canonicalSegments.pop()
      continue
    }
    if (segment !== ".." || !isAbsolute) canonicalSegments.push(segment)
  }

  const joined = canonicalSegments.join("/")
  return isAbsolute ? `/${joined}` : joined
}

export const PRIMARY_SESSION_AGENT = "coordinator"
export const PRIMARY_SESSION_ADMISSION_ERROR =
  "Primary sessions in participating Kinnect repositories require explicit agent: coordinator"

const isParticipatingRepository = (directory: string | null | undefined): boolean => {
  const normalized = canonicalizeDirectory(directory)
  return normalized !== null && PARTICIPATING_REPOSITORY_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  )
}

/** Reject unsafe primary-agent selection before any session-create request. */
export const assertPrimarySessionAdmission = (
  directory: string | null | undefined,
  agent: string | undefined,
): void => {
  if (!isParticipatingRepository(directory) || agent === PRIMARY_SESSION_AGENT) return
  throw new Error(PRIMARY_SESSION_ADMISSION_ERROR)
}
