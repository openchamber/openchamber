import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  getKeystorePassword,
  buildApk,
  isBubblewrapInstalled,
  isQuietMode,
  isJsonMode,
  canPrompt
} from '../scripts/build-apk.mjs'

describe('getKeystorePassword', () => {
  test('returns password from environment variable', async () => {
    process.env.BUBBLEWRAP_KEYSTORE_PASSWORD = 'test-password'

    const password = await getKeystorePassword()
    expect(password).toBe('test-password')

    delete process.env.BUBBLEWRAP_KEYSTORE_PASSWORD
  })

  test('throws in non-interactive mode without env var', async () => {
    delete process.env.BUBBLEWRAP_KEYSTORE_PASSWORD

    // In tests, canPrompt() returns false (non-TTY)
    await expect(getKeystorePassword()).rejects.toThrow('Keystore password required')
  })
})

describe('buildApk', () => {
  test('throws when TWA project not found', async () => {
    // No output directory exists in tests
    await expect(buildApk()).rejects.toThrow('TWA project not found')
  })
})

describe('isBubblewrapInstalled', () => {
  test('returns false when bubblewrap CLI is not installed', () => {
    // bubblewrap is not available in test environments
    expect(isBubblewrapInstalled()).toBe(false)
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

  test('canPrompt returns false in non-TTY', () => {
    // In tests, process.stdout.isTTY is undefined (falsy)
    expect(canPrompt()).toBeFalsy()
  })
})
