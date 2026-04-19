export const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('~')) {
    return trimmed
  }
  if (!homeDir) {
    return trimmed
  }
  if (trimmed === '~') {
    return homeDir
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`
  }
  return trimmed
}

export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  let replaced = trimmed.replace(/\\/g, '/')
  if (replaced === '/') {
    return '/'
  }

  replaced = replaced.replace(/\/+/g, '/')

  if (/^\/+[A-Za-z](?:\/|$)/.test(replaced)) {
    replaced = replaced.replace(/^\/+([A-Za-z])(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`)
  } else if (/^[A-Za-z]:(?:\/|$)/.test(replaced)) {
    replaced = replaced.replace(/^([A-Za-z]):(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`)
  }

  if (replaced.length <= 1) {
    return replaced
  }

  return replaced.replace(/\/+$/, '')
}

export const pathsEqual = (left?: string | null, right?: string | null): boolean => {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a !== null && b !== null && a === b
}

export const isSubpath = (candidate?: string | null, parent?: string | null): boolean => {
  const child = normalizePath(candidate)
  const root = normalizePath(parent)

  if (!child || !root) {
    return false
  }

  if (child === root) {
    return true
  }

  return child.startsWith(`${root}/`)
}
