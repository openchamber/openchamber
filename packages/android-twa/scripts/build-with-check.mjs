#!/usr/bin/env node
/**
 * Conditional build wrapper for the android-twa package.
 *
 * - Checks prerequisites (JDK 17+, TWA project, bubblewrap config)
 * - If all met: runs `bubblewrap build` with the given arguments
 * - If not met: prints a skip message and exits 0
 *
 * This allows `bun run --filter '*' build` to succeed even when JDK
 * is not installed, while still running bubblewrap when prerequisites
 * are available.
 */

import { execSync } from 'child_process'
import { isQuietMode, isJsonMode, printJson, runIfMain } from './cli-output.mjs'
import { checkPrerequisites } from './check-prerequisites.mjs'

function main() {
  const { canBuild, reasons } = checkPrerequisites()

  if (!canBuild) {
 if (isJsonMode()) {
 printJson({ canBuild: false, skipped: true, reasons })
 } else if (!isQuietMode()) {
      console.log('Skipping android-twa build (prerequisites not met):')
      for (const reason of reasons) {
        console.log(`  - ${reason}`)
      }
      console.log('  Run `bun run android:init && bun run android:build` when ready.')
    }
    // Exit 0 so `bun run --filter '*' build` succeeds
    process.exit(0)
  }

  // Prerequisites met — run bubblewrap build with forwarded args
  const bubblewrapArgs = process.argv.slice(2).join(' ')
  const command = `bubblewrap build ${bubblewrapArgs}`.trim()

  try {
    execSync(command, {
      cwd: process.cwd(),
      stdio: 'inherit'
    })
  } catch (error) {
    process.exit(error.status ?? 1)
  }
}

// Run main only when executed directly
runIfMain(import.meta.url, main)
