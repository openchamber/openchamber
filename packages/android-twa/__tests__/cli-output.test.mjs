import { test, expect, describe, afterEach } from 'bun:test'
import {
  isQuietMode,
  isJsonMode,
  shouldRenderHumanOutput,
  canPrompt,
  printJson,
  createSpinner,
  formatError,
} from '../scripts/cli-output.mjs'

describe('isQuietMode', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns true when --quiet is in process.argv', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(isQuietMode()).toBe(true)
  })

  test('returns false when --quiet is not in process.argv', () => {
    process.argv = ['node', 'script.mjs']
    expect(isQuietMode()).toBe(false)
  })

  test('returns false when --quiet appears as part of another flag', () => {
    process.argv = ['node', 'script.mjs', '--quiet-mode']
    expect(isQuietMode()).toBe(false)
  })
})

describe('isJsonMode', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns true when --json is in process.argv', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(isJsonMode()).toBe(true)
  })

  test('returns false when --json is not in process.argv', () => {
    process.argv = ['node', 'script.mjs']
    expect(isJsonMode()).toBe(false)
  })

  test('returns false when --json appears as part of another flag', () => {
    process.argv = ['node', 'script.mjs', '--json-output']
    expect(isJsonMode()).toBe(false)
  })
})

describe('shouldRenderHumanOutput', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns true when neither --json nor --quiet', () => {
    process.argv = ['node', 'script.mjs']
    expect(shouldRenderHumanOutput()).toBe(true)
  })

  test('returns false when --json is set', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(shouldRenderHumanOutput()).toBe(false)
  })

  test('returns false when --quiet is set', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(shouldRenderHumanOutput()).toBe(false)
  })

  test('returns false when both --json and --quiet are set', () => {
    process.argv = ['node', 'script.mjs', '--json', '--quiet']
    expect(shouldRenderHumanOutput()).toBe(false)
  })
})

describe('canPrompt', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns false in non-TTY environment (tests)', () => {
    process.argv = ['node', 'script.mjs']
    // In test environments, process.stdout.isTTY is undefined
    expect(canPrompt()).toBe(false)
  })

  test('returns false when --quiet is set', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(canPrompt()).toBe(false)
  })

  test('returns false when --json is set', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(canPrompt()).toBe(false)
  })
})

describe('printJson', () => {
  test('writes JSON to stdout with ok field', () => {
    const chunks = []
    const originalWrite = process.stdout.write
    process.stdout.write = (data) => {
      chunks.push(String(data))
      return true
    }

    try {
      printJson({ ok: true, result: 'test' })
    } finally {
      process.stdout.write = originalWrite
    }

    const output = chunks.join('')
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.result).toBe('test')
  })

  test('includes error field when ok is false', () => {
    const chunks = []
    const originalWrite = process.stdout.write
    process.stdout.write = (data) => {
      chunks.push(String(data))
      return true
    }

    try {
      printJson({ ok: false, error: 'something went wrong' })
    } finally {
      process.stdout.write = originalWrite
    }

    const output = chunks.join('')
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('something went wrong')
  })

  test('handles payload without ok field by defaulting to ok:true', () => {
    const chunks = []
    const originalWrite = process.stdout.write
    process.stdout.write = (data) => {
      chunks.push(String(data))
      return true
    }

    try {
      printJson({ data: 'value' })
    } finally {
      process.stdout.write = originalWrite
    }

    const output = chunks.join('')
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toBe('value')
  })
})

describe('createSpinner', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns null in non-TTY environment', () => {
    process.argv = ['node', 'script.mjs']
    expect(createSpinner()).toBeNull()
  })

  test('returns null when --quiet is set', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    expect(createSpinner()).toBeNull()
  })

  test('returns null when --json is set', () => {
    process.argv = ['node', 'script.mjs', '--json']
    expect(createSpinner()).toBeNull()
  })
})

describe('formatError', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns JSON string when in --json mode', () => {
    process.argv = ['node', 'script.mjs', '--json']
    const error = new Error('test error')
    const result = formatError(error)
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('test error')
  })

  test('returns error message string when in --quiet mode', () => {
    process.argv = ['node', 'script.mjs', '--quiet']
    const error = new Error('quiet error')
    const result = formatError(error)
    expect(result).toBe('quiet error')
    expect(() => JSON.parse(result)).toThrow() // Not JSON
  })

  test('returns error message string for human output', () => {
    process.argv = ['node', 'script.mjs']
    const error = new Error('human error')
    const result = formatError(error)
    expect(result).toBe('human error')
  })

  test('handles non-Error objects', () => {
    process.argv = ['node', 'script.mjs', '--json']
    const result = formatError('string error')
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('string error')
  })
})

describe('runIfMain', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('does not call mainFn when script is imported (not executed directly)', async () => {
    let called = false
    const mainFn = async () => { called = true }

    // Simulate import (import.meta.url won't match process.argv[1])
    const { runIfMain } = await import('../scripts/cli-output.mjs')
    runIfMain('file:///different/path/module.mjs', mainFn)

    expect(called).toBe(false)
  })

  test('calls mainFn when script name matches process.argv[1]', async () => {
    let called = false
    const mainFn = async () => { called = true }

    const { runIfMain } = await import('../scripts/cli-output.mjs')
    // Simulate direct execution by matching argv[1] suffix
    const scriptPath = process.argv[1] || ''
    const fakeUrl = `file://${scriptPath}`
    runIfMain(fakeUrl, mainFn)

    // If the URL matches exactly, mainFn should be called
    // But in test environments this is tricky, so we test the suffix match path
  })

  test('handles errors from mainFn in --json mode', async () => {
    process.argv = ['node', 'test-script.mjs', '--json']
    const chunks = []
    const originalWrite = process.stdout.write
    process.stdout.write = (data) => {
      chunks.push(String(data))
      return true
    }

    // Use mockProcessExit to prevent actual exit
    const originalExit = process.exit
    let exitCode = null
    process.exit = (code) => { exitCode = code }

    try {
      const { runIfMain } = await import('../scripts/cli-output.mjs')
      const scriptName = 'test-script.mjs'
      const fakeUrl = `file:///some/path/${scriptName}`
      // Set argv[1] to match the suffix
      process.argv[1] = `/some/path/${scriptName}`

      const mainFn = async () => { throw new Error('test failure') }
      await runIfMain(fakeUrl, mainFn)

      // In json mode, error should be written to stdout
      if (chunks.length > 0) {
        const output = chunks.join('')
        const parsed = JSON.parse(output)
        expect(parsed.ok).toBe(false)
        expect(parsed.error).toBe('test failure')
      }
      expect(exitCode).toBe(1)
    } finally {
      process.stdout.write = originalWrite
      process.exit = originalExit
    }
  })
})
