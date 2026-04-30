#!/usr/bin/env node
/**
 * Guard script for the android-twa "build" npm script.
 *
 * 1. Checks for Android SDK presence.
 *    When absent, prints a skip message and exits 0 so `bun run build --filter '*'`
 *    succeeds on CI runners that lack Android tooling.
 *
 * 2. Generates configurable-wrapper/local.properties from environment variables
 *    (or uses the existing file if present). This avoids committing plaintext
 *    secrets — the CI workflow generates this file at build time from secrets/env.
 *
 * SDK detection order:
 * 1. ANDROID_HOME pointing to an existing directory
 * 2. ANDROID_SDK_ROOT pointing to an existing directory
 * 3. ~/Android/Sdk (default Linux/macOS location)
 * 4. local.properties sdk.dir pointing to an existing directory
 *
 * Environment variables for local.properties generation:
 *   KEYSTORE_PASSWORD  (default: 'ci-temp-')
 *   KEY_PASSWORD       (default: same as KEYSTORE_PASSWORD)
 *   TWA_HOST           (default: 'openchamber.app')
 *   TWA_DEFAULT_URL    (default: 'https://openchamber.app')
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gradleCwd = join(__dirname, "..", "configurable-wrapper");
const propsPath = join(gradleCwd, "local.properties");

// --- SDK detection ---

function sdkDirFromLocalProperties() {
  try {
    if (!existsSync(propsPath)) return null;
    const content = readFileSync(propsPath, "utf8");
    const match = content.match(/^sdk\.dir\s*=\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function hasAndroidSdk() {
  if (process.env.ANDROID_HOME && existsSync(process.env.ANDROID_HOME)) return true;
  if (process.env.ANDROID_SDK_ROOT && existsSync(process.env.ANDROID_SDK_ROOT)) return true;
  if (existsSync(join(homedir(), "Android", "Sdk"))) return true;
  const localSdkDir = sdkDirFromLocalProperties();
  if (localSdkDir && existsSync(localSdkDir)) return true;
  return false;
}

// --- local.properties generation ---

/**
 * Generate local.properties from env vars if it doesn't already exist.
 * This matches the CI workflow pattern (android-twa.yml 'Create local.properties' step)
 * and avoids committing plaintext secrets to the repository.
 */
function ensureLocalProperties() {
  if (existsSync(propsPath)) return; // already present (user-created or CI)

  const keystorePassword = process.env.KEYSTORE_PASSWORD || "ci-temp-";
  const keyPassword = process.env.KEY_PASSWORD || keystorePassword;
  const twaHost = process.env.TWA_HOST || "openchamber.app";
  const twaDefaultUrl = process.env.TWA_DEFAULT_URL || "https://openchamber.app";

  const lines = [
    `keystore.path=../android.keystore`,
    `keystore.alias=openchamber`,
    `keystore.password=${keystorePassword}`,
    `keystore.keyPassword=${keyPassword}`,
    `twa.hostName=${twaHost}`,
    `twa.defaultUrl=${twaDefaultUrl}`,
  ];

  writeFileSync(propsPath, lines.join("\n") + "\n", "utf8");
  console.log("Generated local.properties from environment variables");
}

// --- Main ---

if (!hasAndroidSdk()) {
  console.log("Skipping: Android SDK not found (set ANDROID_HOME for TWA builds)");
  process.exit(0);
}

// Ensure local.properties exists before Gradle runs
ensureLocalProperties();

// Determine which Gradle task to run (default: assembleRelease)
const task = process.argv[2] || "assembleRelease";
execSync(`./gradlew ${task}`, { stdio: "inherit", cwd: gradleCwd });
