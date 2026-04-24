#!/usr/bin/env node
import { intro, outro, log, spinner } from '@clack/prompts'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

const isQuietMode = () => process.argv.includes('--quiet')
const isJsonMode = () => process.argv.includes('--json')
const shouldRenderHumanOutput = () => !isJsonMode() && !isQuietMode()

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
  try {
    if (shouldRenderHumanOutput()) {
      intro('Extract SHA-256 Fingerprint')
    }

    const keystorePath = process.env.TWA_KEYSTORE_PATH || 
      resolve(process.cwd(), 'packages/android-twa/android.keystore')

    if (!existsSync(keystorePath)) {
      throw new Error(`Keystore not found: ${keystorePath}`)
    }

    const alias = process.env.TWA_KEY_ALIAS || 'openchamber'
    
    let spin;
    if (shouldRenderHumanOutput()) {
      spin = spinner()
      spin.start('Extracting fingerprint...')
    }

    const fingerprint = extractFingerprint(keystorePath, alias)
    
    if (spin) {
      spin.stop('Done')
    }

    if (isJsonMode()) {
      console.log(JSON.stringify({
        ok: true,
        fingerprint,
        keystore: keystorePath,
        alias
      }))
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
  extractFingerprint,
  isQuietMode,
  isJsonMode
}

// Run main only when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('fingerprint.mjs')) {
  main()
}
