import { test, expect, describe, afterEach } from 'bun:test'
import {
 checkJdk,
 parseJavaVersion,
 checkTwaProject,
 checkBubblewrapConfig,
 checkPrerequisites,
} from '../scripts/check-prerequisites.mjs'

describe('parseJavaVersion', () => {
  test('parses JDK 8 version format', () => {
    expect(parseJavaVersion('java version "1.8.0_352"')).toBe(8)
  })

  test('parses JDK 11 version format', () => {
    expect(parseJavaVersion('openjdk version "11.0.17" 2023-01-17')).toBe(11)
  })

  test('parses JDK 17 version format', () => {
    expect(parseJavaVersion('openjdk version "17.0.6" 2023-01-17')).toBe(17)
  })

  test('parses JDK 21 version format', () => {
    expect(parseJavaVersion('openjdk version "21.0.1" 2023-10-17')).toBe(21)
  })

  test('returns null for unparseable output', () => {
    expect(parseJavaVersion('not a version string')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseJavaVersion('')).toBeNull()
  })
})

describe('checkJdk', () => {
  test('returns object with available and version fields', () => {
    const result = checkJdk()
    expect(result).toHaveProperty('available')
    expect(result).toHaveProperty('version')
    expect(typeof result.available).toBe('boolean')
  })
})

describe('checkTwaProject', () => {
  test('returns false when no output directory exists', () => {
    // In the test environment, no TWA output directory exists
    expect(checkTwaProject()).toBe(false)
  })
})

describe('checkBubblewrapConfig', () => {
  test('returns boolean', () => {
    const result = checkBubblewrapConfig()
    expect(typeof result).toBe('boolean')
  })
})

describe('checkPrerequisites', () => {
  test('returns object with canBuild and reasons', () => {
    const result = checkPrerequisites()
    expect(result).toHaveProperty('canBuild')
    expect(result).toHaveProperty('reasons')
    expect(typeof result.canBuild).toBe('boolean')
    expect(Array.isArray(result.reasons)).toBe(true)
  })

  test('returns reasons when prerequisites not met', () => {
    const result = checkPrerequisites()
    if (!result.canBuild) {
      expect(result.reasons.length).toBeGreaterThan(0)
    }
  })
})

