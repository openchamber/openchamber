import { test, expect, describe } from 'bun:test'
import { generateAssetlinksJson, extractFingerprint, isQuietMode, isJsonMode } from '../scripts/generate-assetlinks.mjs'

describe('generateAssetlinksJson', () => {
  test('generates correct assetlinks.json structure', () => {
  const packageId = 'ai.opencode.openchamber.configurable'
    const fingerprint = '14:6D:E9:A3:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55'

    const result = generateAssetlinksJson(packageId, fingerprint)
    const parsed = JSON.parse(result)

    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(1)
    expect(parsed[0].relation).toContain('delegate_permission/common.handle_all_urls')
    expect(parsed[0].target.namespace).toBe('android_app')
    expect(parsed[0].target.package_name).toBe(packageId)
    expect(parsed[0].target.sha256_cert_fingerprints).toContain(fingerprint)
  })

  test('produces valid JSON', () => {
    const result = generateAssetlinksJson('com.test.app', 'AA:BB:CC')
    expect(() => JSON.parse(result)).not.toThrow()
  })

  test('formats with proper indentation', () => {
    const result = generateAssetlinksJson('com.test.app', 'AA:BB:CC')
    expect(result).toContain('\n  ') // 2-space indentation
  })
})

describe('extractFingerprint parsing', () => {
  test('parses SHA-256 from keytool output', () => {
    const mockOutput = `
Certificate fingerprints:
	 SHA256: 14:6D:E9:A3:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55
`
    const match = mockOutput.match(/SHA256: ([A-F0-9:]+)/)
    expect(match).not.toBeNull()
    expect(match[1]).toBe('14:6D:E9:A3:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55')
  })
})

describe('mode helpers', () => {
  const originalArgv = process.argv

  test('isQuietMode detects --quiet flag', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(isQuietMode()).toBe(true)
    process.argv = originalArgv
  })

  test('isJsonMode detects --json flag', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(isJsonMode()).toBe(true)
    process.argv = originalArgv
  })
})
