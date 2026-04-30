#!/usr/bin/env node
import { intro, outro, password, log, cancel, isCancel, isQuietMode, isJsonMode, canPrompt, shouldRenderHumanOutput, printJson, createSpinner, runIfMain } from './cli-output.mjs'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

function isBubblewrapInstalled() {
  try {
    execFileSync('bubblewrap', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function getKeystorePassword() {
  const envPassword = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD
  if (envPassword) return envPassword

  if (canPrompt()) {
    const pwd = await password({
      message: 'Enter keystore password',
      mask: '*'
    })
    if (isCancel(pwd)) {
      cancel('Cancelled')
      process.exit(1)
    }
    return pwd
  }

  throw new Error('Keystore password required. Set BUBBLEWRAP_KEYSTORE_PASSWORD or run in interactive mode.')
}

async function buildAab() {
  // Try package directory first, then root directory
  let projectPath = resolve(process.cwd(), 'output')
  if (!existsSync(projectPath)) {
    projectPath = resolve(process.cwd(), 'packages/android-twa/output')
  }
  if (!existsSync(projectPath)) {
    throw new Error('TWA project not found. Run `init` first.')
  }

  const spin = createSpinner()
  spin?.start('Building Android App Bundle...')

  try {
    if (!isBubblewrapInstalled()) {
      throw new Error('Bubblewrap CLI not found. Install with: npm install -g @bubblewrap/cli')
    }
    execFileSync('bubblewrap', ['build', '--generateAppBundle'], {
      cwd: projectPath,
      stdio: canPrompt() ? 'inherit' : 'pipe'
    })

    spin?.stop('AAB built successfully')
    if (shouldRenderHumanOutput()) {
      log.success(`AAB: packages/android-twa/output/app-release-bundle.aab`)
      log.info('Upload to Play Store: https://play.google.com/console')
    }
  } catch (error) {
    spin?.stop('Build failed')
    throw error
  }
}

async function main() {
  if (shouldRenderHumanOutput()) {
    intro('OpenChamber TWA AAB Build')
  }

  const pwd = await getKeystorePassword()
  process.env.BUBBLEWRAP_KEYSTORE_PASSWORD = pwd
  process.env.BUBBLEWRAP_KEY_PASSWORD = pwd

  await buildAab()

  if (isJsonMode()) {
    printJson({ ok: true, aab: 'packages/android-twa/output/app-release-bundle.aab' })
  } else if (isQuietMode()) {
    console.log('packages/android-twa/output/app-release-bundle.aab')
  } else {
    outro('Ready for Play Store!')
  }
}

// Export functions for testing
export {
  getKeystorePassword,
  buildAab,
  isBubblewrapInstalled,
}

// Run main only when executed directly (not when imported for testing)
runIfMain(import.meta.url, main)
