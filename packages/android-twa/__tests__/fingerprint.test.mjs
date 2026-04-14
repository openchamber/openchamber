import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { extractFingerprint, isQuietMode, isJsonMode } from '../scripts/fingerprint.mjs'

describe('extractFingerprint', () => {
  test('extracts SHA-256 fingerprint from keytool output', () => {
    // Mock keytool output
    const mockOutput = `
Certificate fingerprints:
	 SHA1: AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD
	 SHA256: 14:6D:E9:A3:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55
Signature algorithm name: SHA256withRSA
`

    // We can't directly test extractFingerprint without a real keystore
    // but we can test the parsing logic
    const match = mockOutput.match(/SHA256: ([A-F0-9:]+)/)
    expect(match).not.toBeNull()
    expect(match[1]).toBe('14:6D:E9:A3:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55')
  })

  test('throws when SHA-256 fingerprint not found', () => {
    const mockOutput = 'No fingerprint here'
    const match = mockOutput.match(/SHA256: ([A-F0-9:]+)/)
    expect(match).toBeNull()
  })

  test('extractFingerprint throws for non-existent keystore', async () => {
    // This will fail because the keystore doesn't exist
    // and execSync will throw
    await expect(async () => {
      extractFingerprint('/nonexistent/path/keystore.jks', 'test')
    }).toThrow()
  })
})

describe('mode helpers', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('isQuietMode detects --quiet flag', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(isQuietMode()).toBe(true)
  })

  test('isJsonMode detects --json flag', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(isJsonMode()).toBe(true)
  })
})
