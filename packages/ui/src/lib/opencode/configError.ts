import { z } from "zod"

/**
 * A project's OpenCode config that OpenCode refused to load. OpenCode answers
 * every directory-scoped request for that project with the same error until
 * the file is fixed, so retrying cannot help; the user has to edit the file.
 */
export type ProjectConfigError = {
  /** OpenCode's error name, e.g. `ConfigInvalidError` or `ConfigJsonError`. */
  name: string
  /** The config file OpenCode rejected, when it named one. */
  path: string | undefined
  /** What OpenCode said is wrong, with schema issues joined one per line. */
  message: string
}

const CONFIG_ERROR_NAMES = new Set([
  "ConfigInvalidError",
  "ConfigJsonError",
  "ConfigFrontmatterError",
  "ConfigDirectoryTypoError",
])

const issueSchema = z.object({ message: z.string(), path: z.array(z.string()).optional() })

const namedConfigErrorSchema = z.object({
  name: z.string(),
  data: z.object({
    path: z.string().optional(),
    message: z.string().optional(),
    issues: z.array(issueSchema).optional(),
    dir: z.string().optional(),
    suggestion: z.string().optional(),
  }),
})

const causeCarrierSchema = z.object({ cause: z.unknown() })

const describe = (data: z.infer<typeof namedConfigErrorSchema>["data"]): string => {
  const issues = (data.issues ?? [])
    .map((issue) => {
      const text = issue.message.trim()
      return issue.path && issue.path.length > 0 ? `${issue.path.join(".")}: ${text}` : text
    })
    .filter((line) => line.length > 0)
  if (issues.length > 0) return issues.join("\n")
  const message = data.message?.trim() ?? ""
  if (message.length > 0) return message
  if (data.dir && data.suggestion) return `${data.dir} → ${data.suggestion}`
  return ""
}

/**
 * Finds OpenCode's named config error anywhere in a thrown error's cause
 * chain. The generated client throws the 400 body merged into an `Error`
 * (`name` + `data`), and `OpencodeApiError` keeps that as its `cause`.
 */
export function readProjectConfigError(cause: unknown): ProjectConfigError | null {
  let current: unknown = cause
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const named = namedConfigErrorSchema.safeParse(current)
    if (named.success && CONFIG_ERROR_NAMES.has(named.data.name)) {
      return {
        name: named.data.name,
        path: named.data.data.path && named.data.data.path !== "config" ? named.data.data.path : undefined,
        message: describe(named.data.data),
      }
    }
    const carrier = causeCarrierSchema.safeParse(current)
    current = carrier.success ? carrier.data.cause : null
  }
  return null
}

export const isSameProjectConfigError = (a: ProjectConfigError | undefined, b: ProjectConfigError | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.name === b.name && a.path === b.path && a.message === b.message)
