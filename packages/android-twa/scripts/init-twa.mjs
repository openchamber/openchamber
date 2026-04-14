#!/usr/bin/env node
import { intro, outro, text, confirm, select, password, log, spinner, cancel, isCancel } from '@clack/prompts'
import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

function isQuietMode() {
  return process.argv.includes('--quiet')
}

function isJsonMode() {
  return process.argv.includes('--json')
}

function isValidateOnly() {
  return process.argv.includes('--validate-only')
}

function canPrompt() {
  return process.stdout.isTTY && !isQuietMode() && !isJsonMode()
}

function validateHttps(url) {
  if (!url.startsWith('https://')) {
    throw new Error('TWA requires HTTPS. HTTP URLs are not supported.')
  }
}

function validateUrl(url) {
  try {
    new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
}

function validateManifestUrl(url) {
  validateHttps(url)
  validateUrl(url)
}

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8')
    content.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        const value = match[2].trim().replace(/^["']|["']$/g, '')
        if (!process.env[key]) {
          process.env[key] = value
        }
      }
    })
  }
}

async function ensureBubblewrapInstalled() {
  try {
    execSync('bubblewrap --version', { stdio: 'ignore' })
    return true
  } catch {
    if (canPrompt()) {
      const shouldInstall = await confirm({
        message: 'Bubblewrap CLI not found. Install it now?',
        initialValue: true
      })
      if (isCancel(shouldInstall) || !shouldInstall) {
        cancel('Bubblewrap is required for TWA builds.')
        process.exit(1)
      }
      // Install via npm
      execSync('npm install -g @bubblewrap/cli', { stdio: 'inherit' })
    } else {
      throw new Error('Bubblewrap CLI not found. Install with: npm install -g @bubblewrap/cli')
    }
  }
}

async function collectConfig() {
  const config = {
    manifestUrl: process.env.TWA_MANIFEST_URL,
    host: process.env.TWA_HOST,
    packageId: process.env.TWA_PACKAGE_ID || 'ai.opencode.openchamber.twa',
    keystorePath: process.env.TWA_KEYSTORE_PATH,
    keyAlias: process.env.TWA_KEY_ALIAS || 'openchamber'
  }

  if (canPrompt()) {
    intro('OpenChamber TWA Initialization')

    if (!config.manifestUrl) {
      const url = await text({
        message: 'Enter your OpenChamber web manifest URL',
        placeholder: 'https://your-domain.com/site.webmanifest',
        validate: (value) => {
          if (!value) return 'URL is required'
          if (!value.startsWith('https://')) return 'Must be HTTPS'
          try { new URL(value) } catch { return 'Invalid URL' }
        }
      })
      if (isCancel(url)) { cancel('Cancelled'); process.exit(1) }
      config.manifestUrl = url
    }

    if (!config.host) {
      const hostUrl = new URL(config.manifestUrl)
      config.host = hostUrl.hostname
    }

    if (!process.env.TWA_PACKAGE_ID) {
      const pkgId = await text({
        message: 'Enter your Android package ID',
        initialValue: config.packageId,
        validate: (value) => {
          if (!value) return 'Package ID is required'
          if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+[0-9a-z_]$/i.test(value)) return 'Invalid package ID format'
        }
      })
      if (isCancel(pkgId)) { cancel('Cancelled'); process.exit(1) }
      config.packageId = pkgId
    }
  } else {
    if (!config.manifestUrl) {
      throw new Error('Missing required configuration: TWA_MANIFEST_URL environment variable is required in non-interactive mode.')
    }
  }

  // Validate even in non-interactive mode
  validateManifestUrl(config.manifestUrl)

  return config
}

async function runBubblewrapInit(config) {
  const spin = spinner()
  if (canPrompt()) {
    spin.start('Initializing TWA project...')
  }

  try {
    const args = [
      'init',
      '--manifest', config.manifestUrl,
      '--directory', './output'
    ]

    // Determine the correct working directory:
    // - If run via `bun run --cwd packages/android-twa init`, cwd is packages/android-twa/
    // - If run from repo root, we need to use packages/android-twa/
    // Check if we're already in the android-twa directory by looking for package.json
    const cwd = process.cwd()
    const isInAndroidTwa = existsSync(resolve(cwd, 'package.json')) && 
      existsSync(resolve(cwd, 'scripts'))
    const twaDir = isInAndroidTwa ? cwd : resolve(cwd, 'packages/android-twa')
    
    if (!existsSync(twaDir)) {
      mkdirSync(twaDir, { recursive: true })
    }

    // Run bubblewrap init
    execSync(`bubblewrap ${args.join(' ')}`, {
      cwd: twaDir,
      stdio: canPrompt() ? 'inherit' : 'pipe'
    })

    const outputDir = resolve(twaDir, 'output')
    if (canPrompt()) {
      spin.stop('TWA project initialized')
      log.success(`Output directory: ${outputDir}`)
    } else if (!isQuietMode() && !isJsonMode()) {
      console.log('TWA project initialized successfully.')
    }
  } catch (error) {
    if (canPrompt()) {
      spin.stop('Initialization failed')
    }
    throw error
  }
}

async function main() {
  try {
    loadEnv()
    await ensureBubblewrapInstalled()
    const config = await collectConfig()

    if (isValidateOnly()) {
      // Only validate the manifest URL, don't initialize the project
      execSync(`bubblewrap validate --url=${config.manifestUrl}`, {
        stdio: canPrompt() ? 'inherit' : 'pipe'
      })
      if (isJsonMode()) {
        console.log(JSON.stringify({ ok: true, message: 'Manifest URL is valid!' }))
      } else if (canPrompt()) {
        outro('Manifest URL is valid!')
      } else if (!isQuietMode()) {
        console.log('Manifest URL is valid!')
      }
      return
    }

    await runBubblewrapInit(config)
    
    if (isJsonMode()) {
      console.log(JSON.stringify({ ok: true, message: 'TWA project ready!' }))
    } else if (canPrompt()) {
      outro('TWA project ready!')
    } else if (!isQuietMode()) {
      console.log('TWA project ready!')
    }
  } catch (error) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ ok: false, error: error.message }))
    } else if (canPrompt()) {
      log.error(error.message)
    } else {
      console.error(error.message)
    }
    process.exit(1)
  }
}

// Export functions for testing
export {
  validateHttps,
  validateUrl,
  validateManifestUrl,
  loadEnv,
  collectConfig,
  isQuietMode,
  isJsonMode,
  canPrompt
}

// Run main only when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('init-twa.mjs')) {
  main()
}
