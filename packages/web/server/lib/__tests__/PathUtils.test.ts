import { describe, expect, it } from 'bun:test'

import {
  canonicalPath,
  isSubpath,
  joinPosix,
  longPathPrefix,
  pathsEqual,
  toNativePath,
} from '../PathUtils.js'

describe('PathUtils', () => {
  it('canonicalizes absolute paths for persistence', () => {
    if (process.platform === 'win32') {
      expect(canonicalPath('C:\\Users\\Test\\project\\')).toBe('/c/Users/Test/project')
      expect(canonicalPath('C:/Users/Test//project')).toBe('/c/Users/Test/project')
      return
    }

    expect(canonicalPath('/tmp/project/')).toBe('/tmp/project')
  })

  it('restores native paths for filesystem operations', () => {
    if (process.platform === 'win32') {
      expect(toNativePath('/c/Users/Test/project')).toBe('C:\\Users\\Test\\project')
      return
    }

    expect(toNativePath('/tmp/project')).toBe('/tmp/project')
  })

  it('compares Windows paths case-insensitively', () => {
    if (process.platform === 'win32') {
      expect(pathsEqual('C:\\Users\\Test\\Project', 'c:/users/test/project/')).toBe(true)
      return
    }

    expect(pathsEqual('/tmp/project', '/tmp/project')).toBe(true)
    expect(pathsEqual('/tmp/project', '/tmp/Project')).toBe(false)
  })

  it('checks subpath relationships from canonical paths', () => {
    if (process.platform === 'win32') {
      expect(isSubpath('C:\\Users\\Test\\project\\src', 'C:/Users/Test/project')).toBe(true)
      expect(isSubpath('D:\\other', 'C:/Users/Test/project')).toBe(false)
      return
    }

    expect(isSubpath('/tmp/project/src', '/tmp/project')).toBe(true)
    expect(isSubpath('/tmp/other', '/tmp/project')).toBe(false)
  })

  it('joins paths with posix separators', () => {
    expect(joinPosix('/c/Users/Test', 'project', 'src/index.ts')).toBe('/c/Users/Test/project/src/index.ts')
  })

  it('adds a long path prefix on Windows only', () => {
    const input = process.platform === 'win32' ? 'C:\\Users\\Test\\project' : '/tmp/project'
    const result = longPathPrefix(input)

    if (process.platform === 'win32') {
      expect(result.startsWith('\\\\?\\')).toBe(true)
      return
    }

    expect(result).toBe('/tmp/project')
  })
})
