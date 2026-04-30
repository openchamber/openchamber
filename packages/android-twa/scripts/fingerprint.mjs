#!/usr/bin/env node
import { intro, outro, log, isQuietMode, isJsonMode, shouldRenderHumanOutput, printJson, createSpinner, runIfMain } from './cli-output.mjs'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

function extractFingerprint(keystorePath, alias = 'openchamber') {
  try {
    const keytoolArgs = ['-list', '-v', '-keystore', keystorePath, '-alias', alias]
    const storePass = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD || process.env.TWA_KEYSTORE_PASSWORD
    if (storePass) {
      keytoolArgs.push('-storepass', storePass)
    }
    const output = execFileSync('keytool', keytoolArgs, { encoding: 'utf-8' })
    const match = output.match(/SHA256: ([A-F0-9:]+)/)
    if (!match) {
      throw new Error('Could not find SHA-256 fingerprint in keystore')
    }
    return match[1]
  } catch (error) {
    throw new Error(`Failed to extract fingerprint: ${error.message}`)
  }
}

async function main() {
  if (shouldRenderHumanOutput()) {
    intro('Extract SHA-256 Fingerprint')
  }

  const keystorePath = process.env.TWA_KEYSTORE_PATH ||
    resolve(process.cwd(), 'packages/android-twa/android.keystore')

  if (!existsSync(keystorePath)) {
    throw new Error(`Keystore not found: ${keystorePath}`)
  }

  const alias = process.env.TWA_KEY_ALIAS || 'openchamber'

  const spin = createSpinner()
  spin?.start('Extracting fingerprint...')

  const fingerprint = extractFingerprint(keystorePath, alias)

  spin?.stop('Done')

  if (isJsonMode()) {
    printJson({
      ok: true,
      fingerprint,
      keystore: keystorePath,
      alias
    })
  } else if (isQuietMode()) {
    console.log(fingerprint)
  } else {
    log.success(`SHA-256 Fingerprint: ${fingerprint}`)
    log.info('Copy this fingerprint for your assetlinks.json')
  }

  if (shouldRenderHumanOutput()) {
    outro('Ready for assetlinks.json generation')
  }
  return fingerprint
}

// Export functions for testing
export {
  extractFingerprint,
}

// Run main only when executed directly (not when imported for testing)
runIfMain(import.meta.url, main)
