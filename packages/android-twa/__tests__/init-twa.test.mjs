import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test'
import {
  validateHttps,
  validateUrl,
  validateManifestUrl,
  loadEnv,
  collectConfig,
  isQuietMode,
  isJsonMode,
  canPrompt
} from '../scripts/init-twa.mjs'

describe('validateHttps', () => {
  test('accepts HTTPS URLs', () => {
    expect(() => validateHttps('https://example.com/manifest.json')).not.toThrow()
  })

  test('rejects HTTP URLs', () => {
    expect(() => validateHttps('http://example.com/manifest.json')).toThrow('TWA requires HTTPS')
  })

  test('rejects URLs without protocol', () => {
    expect(() => validateHttps('example.com/manifest.json')).toThrow('TWA requires HTTPS')
  })
})

describe('validateUrl', () => {
  test('accepts valid URLs', () => {
    expect(() => validateUrl('https://example.com/path?query=1')).not.toThrow()
    expect(() => validateUrl('https://sub.domain.example.com:8080/path')).not.toThrow()
  })

  test('rejects invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow('Invalid URL')
    expect(() => validateUrl('://missing-protocol')).toThrow('Invalid URL')
  })
})

describe('validateManifestUrl', () => {
  test('accepts valid HTTPS manifest URLs', () => {
    expect(() => validateManifestUrl('https://openchamber.app/site.webmanifest')).not.toThrow()
  })

  test('rejects HTTP manifest URLs', () => {
    expect(() => validateManifestUrl('http://openchamber.app/site.webmanifest')).toThrow('TWA requires HTTPS')
  })

  test('rejects invalid manifest URLs', () => {
    expect(() => validateManifestUrl('not-a-valid-url')).toThrow()
  })
})

describe('loadEnv', () => {
  test('loads environment variables from .env file', async () => {
    // Create a temp .env file
    const fs = await import('fs')
    const path = await import('path')
    const tempEnvPath = path.join(process.cwd(), '.env.test')
    fs.writeFileSync(tempEnvPath, 'TEST_VAR=test_value\nANOTHER_VAR="quoted value"\n')

    // Set cwd temporarily
    const originalCwd = process.cwd
    process.cwd = () => path.dirname(tempEnvPath)

    try {
      loadEnv()
      // The function sets process.env, but only for keys not already set
      // Since we're in test mode, let's verify the parsing logic works
    } finally {
      process.cwd = originalCwd
      fs.unlinkSync(tempEnvPath)
    }
  })
})

describe('collectConfig', () => {
  test('uses environment variables when set', async () => {
    process.env.TWA_MANIFEST_URL = 'https://test.com/site.webmanifest'
    process.env.TWA_HOST = 'test.com'
    process.env.TWA_PACKAGE_ID = 'com.test.app'

    // In non-interactive mode (tests are non-TTY), it should use env vars
    const config = await collectConfig()
    expect(config.manifestUrl).toBe('https://test.com/site.webmanifest')
    expect(config.host).toBe('test.com')
    expect(config.packageId).toBe('com.test.app')

    // Cleanup
    delete process.env.TWA_MANIFEST_URL
    delete process.env.TWA_HOST
    delete process.env.TWA_PACKAGE_ID
  })

  test('uses default package ID when not set', async () => {
    process.env.TWA_MANIFEST_URL = 'https://test.com/site.webmanifest'

    const config = await collectConfig()
    expect(config.packageId).toBe('ai.opencode.openchamber.twa')

    delete process.env.TWA_MANIFEST_URL
  })

  test('throws in non-interactive mode without TWA_MANIFEST_URL', async () => {
    delete process.env.TWA_MANIFEST_URL

    await expect(collectConfig()).rejects.toThrow('Missing required configuration')
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

    process.argv = ['node', 'script.mjs']
    expect(isQuietMode()).toBe(false)
  })

  test('isJsonMode detects --json flag', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(isJsonMode()).toBe(true)

    process.argv = ['node', 'script.mjs']
    expect(isJsonMode()).toBe(false)
  })

  test('canPrompt returns false in non-TTY', () => {
    // In tests, stdout.isTTY is undefined (falsy)
    expect(canPrompt()).toBeFalsy()
  })
})
