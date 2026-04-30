import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
 getKeystorePassword,
 buildAab,
 isBubblewrapInstalled,
} from '../scripts/build-aab.mjs'

describe('getKeystorePassword', () => {
  test('returns password from environment variable', async () => {
    process.env.BUBBLEWRAP_KEYSTORE_PASSWORD = 'test-password'

    const password = await getKeystorePassword()
    expect(password).toBe('test-password')

    delete process.env.BUBBLEWRAP_KEYSTORE_PASSWORD
  })

  test('throws in non-interactive mode without env var', async () => {
    delete process.env.BUBBLEWRAP_KEYSTORE_PASSWORD

    await expect(getKeystorePassword()).rejects.toThrow('Keystore password required')
  })
})

describe('buildAab', () => {
  test('throws when TWA project not found', async () => {
    await expect(buildAab()).rejects.toThrow('TWA project not found')
  })
})

describe('isBubblewrapInstalled', () => {
  test('returns false when bubblewrap CLI is not installed', () => {
    // bubblewrap is not available in test environments
    expect(isBubblewrapInstalled()).toBe(false)
  })
})

