#!/usr/bin/env node
import { intro, outro, password, log, spinner, cancel, isCancel } from '@clack/prompts'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

const isQuietMode = () => process.argv.includes('--quiet')
const isJsonMode = () => process.argv.includes('--json')
const canPrompt = () => process.stdout.isTTY && !isQuietMode() && !isJsonMode()

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

  const spin = spinner()
  if (!isQuietMode() && !isJsonMode()) {
    spin.start('Building Android App Bundle...')
  }

  try {
    execSync('bubblewrap build --generateAppBundle', {
      cwd: projectPath,
      stdio: canPrompt() ? 'inherit' : 'pipe'
    })

    if (!isQuietMode() && !isJsonMode()) {
      spin.stop('AAB built successfully')
      log.success(`AAB: packages/android-twa/output/app-release-bundle.aab`)
      log.info('Upload to Play Store: https://play.google.com/console')
    }
  } catch (error) {
    if (!isQuietMode() && !isJsonMode()) {
      spin.stop('Build failed')
    }
    throw error
  }
}

async function main() {
  try {
    if (!isJsonMode() && !isQuietMode()) {
      intro('OpenChamber TWA AAB Build')
    }
    
    const pwd = await getKeystorePassword()
    process.env.BUBBLEWRAP_KEYSTORE_PASSWORD = pwd
    process.env.BUBBLEWRAP_KEY_PASSWORD = pwd
    
    await buildAab()
    
    if (isJsonMode()) {
      console.log(JSON.stringify({ ok: true, aab: 'packages/android-twa/output/app-release-bundle.aab' }))
    } else if (isQuietMode()) {
      console.log('packages/android-twa/output/app-release-bundle.aab')
    } else {
      outro('Ready for Play Store!')
    }
  } catch (error) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ ok: false, error: error.message }))
    } else if (isQuietMode()) {
      console.error(error.message)
    } else {
      log.error(error.message)
    }
    process.exit(1)
  }
}

// Export functions for testing
export {
  getKeystorePassword,
  buildAab,
  isQuietMode,
  isJsonMode,
  canPrompt
}

// Run main only when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('build-aab.mjs')) {
  main()
}
