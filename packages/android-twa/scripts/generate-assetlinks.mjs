#!/usr/bin/env node
import { intro, outro, log, spinner } from '@clack/prompts'
import { execFileSync } from 'child_process'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const isQuietMode = () => process.argv.includes('--quiet')
const isJsonMode = () => process.argv.includes('--json')
const shouldRenderHumanOutput = () => !isJsonMode() && !isQuietMode()

function extractFingerprint(keystorePath, alias) {
 try {
 const keytoolArgs = ['-list', '-v', '-keystore', keystorePath, '-alias', alias]
 const storePass = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD || process.env.TWA_KEYSTORE_PASSWORD
 if (storePass) {
 keytoolArgs.push('-storepass', storePass)
 }
 const output = execFileSync('keytool', keytoolArgs, { encoding: 'utf-8' })
 const match = output.match(/SHA256: ([A-F0-9:]+)/)
 if (!match) throw new Error('Could not find SHA-256 fingerprint')
 return match[1]
 } catch (error) {
 throw new Error(`Failed to extract fingerprint: ${error.message}`)
 }
}

function generateAssetlinksJson(packageId, fingerprint) {
  return JSON.stringify([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageId,
        sha256_cert_fingerprints: [fingerprint]
      }
    }
  ], null, 2)
}

async function main() {
  try {
    if (shouldRenderHumanOutput()) {
      intro('Generate assetlinks.json')
    }

    const keystorePath = process.env.TWA_KEYSTORE_PATH ||
      resolve(process.cwd(), 'packages/android-twa/android.keystore')
    
    if (!existsSync(keystorePath)) {
      throw new Error(`Keystore not found: ${keystorePath}`)
    }

    const alias = process.env.TWA_KEY_ALIAS || 'openchamber'
  const packageId = process.env.TWA_PACKAGE_ID || 'ai.opencode.openchamber.configurable'

    let spin;
    if (shouldRenderHumanOutput()) {
      spin = spinner()
      spin.start('Generating assetlinks.json...')
    }

    const fingerprint = extractFingerprint(keystorePath, alias)
    const assetlinks = generateAssetlinksJson(packageId, fingerprint)

    const outputPath = resolve(process.cwd(), 'packages/android-twa/output/assetlinks.json')
    mkdirSync(resolve(outputPath, '..'), { recursive: true })
    writeFileSync(outputPath, assetlinks, 'utf-8')

    if (spin) {
      spin.stop('Generated!')
    }

    if (isJsonMode()) {
      console.log(JSON.stringify({
        ok: true,
        path: outputPath,
        packageId,
        fingerprint,
        content: JSON.parse(assetlinks)
      }))
    } else if (isQuietMode()) {
      console.log(outputPath)
    } else {
      log.success(`Generated: ${outputPath}`)
      log.info('')
      log.step('Deploy to your domain:')
      log.info('  1. Upload assetlinks.json to your server')
      log.info('  2. Location: https://your-domain.com/.well-known/assetlinks.json')
      log.info('  3. Content-Type: application/json')
      log.info('')
      log.step('Verify with:')
      log.info('  https://developers.google.com/digital-asset-links/tools/generator')
    }

    if (shouldRenderHumanOutput()) {
      outro('Ready for deployment!')
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
  extractFingerprint,
  generateAssetlinksJson,
  isQuietMode,
  isJsonMode
}

// Run main only when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('generate-assetlinks.mjs')) {
  main()
}
