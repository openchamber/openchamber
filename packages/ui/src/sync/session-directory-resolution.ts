
export type SessionDirectorySource =
  | 'authoritative'
  | 'selected'
  | 'attachment'
  | 'worktree-metadata'
  | 'remembered'
  | 'none'

export type SessionDirectorySources = {
  authoritative?: string | null
  selected?: string | null
  attachment?: string | null
  worktreeMetadata?: string | null
  remembered?: string | null
}

export type SessionDirectoryResolution = {
  directory: string | null
  source: SessionDirectorySource
  conflict: { source: SessionDirectorySource; directory: string } | null
}

const RESOLUTION_ORDER: ReadonlyArray<Exclude<SessionDirectorySource, 'none'>> = [
  'authoritative',
  'selected',
  'attachment',
  'worktree-metadata',
  'remembered',
]

const readSource = (
  sources: SessionDirectorySources,
  source: Exclude<SessionDirectorySource, 'none'>,
): string | null => {
  const value = source === 'attachment'
    ? sources.attachment
    : source === 'worktree-metadata'
      ? sources.worktreeMetadata
      : source === 'authoritative'
        ? sources.authoritative
        : source === 'selected'
          ? sources.selected
          : sources.remembered
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const resolveSessionDirectoryFromSources = (
  sources: SessionDirectorySources,
): SessionDirectoryResolution => {
  let winner: { source: SessionDirectorySource; directory: string } | null = null
  let conflict: { source: SessionDirectorySource; directory: string } | null = null

  for (const source of RESOLUTION_ORDER) {
    const directory = readSource(sources, source)
    if (!directory) continue
    if (!winner) {
      winner = { source, directory }
      continue
    }
    if (!conflict && directory !== winner.directory) {
      conflict = { source, directory }
    }
  }

  if (!winner) {
    return { directory: null, source: 'none', conflict: null }
  }

  return { directory: winner.directory, source: winner.source, conflict }
}

export const describeSessionDirectorySources = (
  sources: SessionDirectorySources,
): Array<{ source: SessionDirectorySource; directory: string }> => {
  const described: Array<{ source: SessionDirectorySource; directory: string }> = []
  for (const source of RESOLUTION_ORDER) {
    const directory = readSource(sources, source)
    if (directory) described.push({ source, directory })
  }
  return described
}
