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

async function buildApk() {
  // Check if TWA project exists
  // Try package directory first, then root directory
  let projectPath = resolve(process.cwd(), 'output')
  if (!existsSync(projectPath)) {
    projectPath = resolve(process.cwd(), 'packages/android-twa/output')
  }
  if (!existsSync(projectPath)) {
    throw new Error('TWA project not found. Run `init` first.')
  }

  const spin = createSpinner()
  spin?.start('Building APK...')

  try {
    if (!isBubblewrapInstalled()) {
      throw new Error('Bubblewrap CLI not found. Install with: npm install -g @bubblewrap/cli')
    }
    execFileSync('bubblewrap', ['build'], {
      cwd: projectPath,
      stdio: canPrompt() ? 'inherit' : 'pipe'
    })

    spin?.stop('APK built successfully')
    if (shouldRenderHumanOutput()) {
      log.success(`APK: packages/android-twa/output/app-release-signed.apk`)
    }
  } catch (error) {
    spin?.stop('Build failed')
    throw error
  }
}

async function main() {
  if (shouldRenderHumanOutput()) {
    intro('OpenChamber TWA APK Build')
  }

  const pwd = await getKeystorePassword() // Validates we have password
  // Set password env vars for bubblewrap CLI
  process.env.BUBBLEWRAP_KEYSTORE_PASSWORD = pwd
  process.env.BUBBLEWRAP_KEY_PASSWORD = pwd

  await buildApk()

  if (isJsonMode()) {
    printJson({ ok: true, apk: 'packages/android-twa/output/app-release-signed.apk' })
  } else if (isQuietMode()) {
    console.log('packages/android-twa/output/app-release-signed.apk')
  } else {
    outro('Done!')
  }
}

// Export functions for testing
export {
  getKeystorePassword,
  buildApk,
  isBubblewrapInstalled,
}

// Run main only when executed directly (not when imported for testing)
runIfMain(import.meta.url, main)
