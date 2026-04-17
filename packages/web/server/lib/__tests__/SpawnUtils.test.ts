import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { calculateBackoffDelay, resolveExecutable, spawnManaged, spawnOnceSync } from '../SpawnUtils.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
})

describe('SpawnUtils', () => {
  it('caps exponential backoff delays', () => {
    expect(calculateBackoffDelay(1, 250, 1000)).toBe(250)
    expect(calculateBackoffDelay(2, 250, 1000)).toBe(500)
    expect(calculateBackoffDelay(4, 250, 1000)).toBe(1000)
  })

  it('resolves an executable from PATH', () => {
    expect(resolveExecutable(process.execPath)).toBe(process.execPath)

    const resolved = resolveExecutable(path.basename(process.execPath), {
      pathValue: path.dirname(process.execPath),
    })

    expect(typeof resolved).toBe('string')
    expect(path.basename(resolved || '')).toBe(path.basename(process.execPath))
  })

  it('runs synchronous probe commands', () => {
    const result = spawnOnceSync(process.execPath, ['-e', 'process.stdout.write("sync-ok")'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('sync-ok')
  })

  it('retries managed startup until readiness succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-spawn-utils-'))
    tempDirs.push(tempDir)

    const attemptsFile = path.join(tempDir, 'attempts.txt')
    const script = [
      'const fs = require("node:fs");',
      `const file = ${JSON.stringify(attemptsFile)};`,
      'const next = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "0") + 1;',
      'fs.writeFileSync(file, String(next));',
      'if (next < 3) {',
      '  console.error(`attempt-${next}-failed`);',
      '  process.exit(1);',
      '}',
      'console.log("ready");',
      'setInterval(() => {}, 1000);',
    ].join('\n')

    const managed = await spawnManaged(process.execPath, ['-e', script], {
      startupTimeoutMs: 3000,
      maxRetries: 2,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 20,
      isReadyLine: (line) => line === 'ready',
    })

    expect(fs.readFileSync(attemptsFile, 'utf8')).toBe('3')

    await managed.stop({ force: true })
  })
})
