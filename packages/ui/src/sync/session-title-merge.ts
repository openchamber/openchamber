type SessionWithTitle = {
  id: string
  title?: string | null
}

const DEFAULT_TITLE_PATTERN = /^New session(?: - \d{4}-\d{2}-\d{2}(?:[ T].*)?)?$/

function normalizedTitle(title: string | null | undefined): string {
  return typeof title === "string" ? title.trim() : ""
}

function isDefaultSessionTitle(title: string | null | undefined): boolean {
  const value = normalizedTitle(title)
  return value.length === 0 || DEFAULT_TITLE_PATTERN.test(value)
}

export function mergeSessionPreservingResolvedTitle<T extends SessionWithTitle>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing || existing.id !== incoming.id) {
    return incoming
  }

  const existingTitle = normalizedTitle(existing.title)
  if (existingTitle.length === 0 || isDefaultSessionTitle(existingTitle) || !isDefaultSessionTitle(incoming.title)) {
    return incoming
  }

  return { ...incoming, title: existing.title }
}
