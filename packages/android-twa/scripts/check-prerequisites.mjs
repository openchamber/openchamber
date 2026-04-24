#!/usr/bin/env node
/**
 * Checks whether the prerequisites for building the Android TWA are met.
 *
 * Exit codes:
 *   0 — prerequisites met, proceed to build
 *   2 — prerequisites not met, skip (not an error for monorepo build)
 *
 * Used in package.json scripts via the pattern:
 *   node scripts/check-prerequisites.mjs && bunx bubblewrap build || exit 0
 *
 * - If prerequisites met (exit 0): && runs bubblewrap
 * - If prerequisites not met (exit 2): && is skipped, || exit 0 ensures
 *   the overall script succeeds so `bun run --filter '*' build` continues
 *
 * Prerequisites checked:
 *   1. JDK 17+ available on PATH (or JAVA_HOME)
 *   2. TWA output directory exists (i.e. `init` has been run)
 *   3. Bubblewrap config exists with jdkPath set (prevents interactive prompt)
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'

const isQuietMode = () => process.argv.includes('--quiet')
const isJsonMode = () => process.argv.includes('--json')

/**
 * Check whether JDK 17+ is available.
 * Returns { available: boolean, version: string|null }
 */
function checkJdk() {
  // Try JAVA_HOME first
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const javaBin = join(javaHome, 'bin', 'java')
    try {
      const output = execSync(`"${javaBin}" -version 2>&1`, { stdio: 'pipe' }).toString()
      const version = parseJavaVersion(output)
      if (version && version >= 17) {
        return { available: true, version }
      }
    } catch {
      // Fall through to PATH check
    }
  }

  // Try java on PATH
  try {
    const output = execSync('java -version 2>&1', { stdio: 'pipe' }).toString()
    const version = parseJavaVersion(output)
    if (version && version >= 17) {
      return { available: true, version }
    }
    return { available: false, version }
  } catch {
    return { available: false, version: null }
  }
}

/**
 * Parse major version number from `java -version` output.
 * Output formats vary: "1.8.0_352", "11.0.17", "17.0.6", "21.0.1"
 */
function parseJavaVersion(output) {
  // Match version patterns like "1.8.0_352", "11.0.17", "17.0.6", "21"
  const match = output.match(/"(\d+)(?:\.\d+.*)?"/)
  if (!match) return null
  let major = parseInt(match[1], 10)
  // Java 8 reports as "1.8.x"
  if (major === 1 && match[0].includes('.')) {
    const subMatch = output.match(/"1\.(\d+)/)
    if (subMatch) major = parseInt(subMatch[1], 10)
  }
  return major
}

/**
 * Check whether the TWA output directory exists (init has been run).
 */
function checkTwaProject() {
  // Try package directory first, then root directory
  const paths = [
    resolve(process.cwd(), 'output'),
    resolve(process.cwd(), 'packages/android-twa/output')
  ]
  return paths.some(p => existsSync(p))
}

/**
 * Check whether bubblewrap config exists with jdkPath set.
 * This prevents the interactive JDK installation prompt.
 */
function checkBubblewrapConfig() {
  const configPath = join(homedir(), '.bubblewrap', 'config.json')
  if (!existsSync(configPath)) return false
  try {
    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    return !!(content.jdkPath && content.androidSdkPath)
  } catch {
    return false
  }
}

/**
 * Run all prerequisite checks.
 * Returns { canBuild: boolean, reasons: string[] }
 */
function checkPrerequisites() {
  const reasons = []

  const jdk = checkJdk()
  if (!jdk.available) {
    reasons.push(
      jdk.version
        ? `JDK 17+ required (found JDK ${jdk.version}). Install JDK 17 or set JAVA_HOME.`
        : 'JDK 17+ not found. Install JDK 17 or set JAVA_HOME.'
    )
  }

  const hasTwaProject = checkTwaProject()
  if (!hasTwaProject) {
    reasons.push('TWA project not initialized. Run `bun run android:init` first.')
  }

  const hasBubblewrapConfig = checkBubblewrapConfig()
  if (!hasBubblewrapConfig) {
    reasons.push('Bubblewrap config not found. Run `bunx bubblewrap build` interactively once to set up JDK/SDK paths.')
  }

  return {
    canBuild: jdk.available && hasTwaProject && hasBubblewrapConfig,
    reasons
  }
}

/**
 * Main entry point.
 * Exit 0 = prerequisites met, proceed to build.
 * Exit 2 = prerequisites not met, skip.
 */
function main() {
  const { canBuild, reasons } = checkPrerequisites()

  if (canBuild) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ ok: true, canBuild: true }))
    }
    process.exit(0)
  }

  // Prerequisites not met — skip with informative message
  if (isJsonMode()) {
    console.log(JSON.stringify({ ok: true, canBuild: false, skipped: true, reasons }))
  } else if (!isQuietMode()) {
    console.log('Skipping android-twa build (prerequisites not met):')
    for (const reason of reasons) {
      console.log(`  - ${reason}`)
    }
    console.log('  Run `bun run android:init && bun run android:build` when ready.')
  }
  process.exit(2)
}

// Export for testing
export {
  checkJdk,
  parseJavaVersion,
  checkTwaProject,
  checkBubblewrapConfig,
  checkPrerequisites,
  isQuietMode,
  isJsonMode
}

// Run main only when executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('check-prerequisites.mjs')) {
  main()
}
