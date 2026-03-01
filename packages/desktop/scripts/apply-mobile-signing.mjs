import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const genRoot = path.join(root, 'src-tauri', 'gen');
const androidRoot = path.join(genRoot, 'android');

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function applyAndroidSigning() {
  if (!(await exists(androidRoot))) {
    return 0;
  }

  const keystoreBase64 = process.env.ANDROID_KEYSTORE_BASE64 || '';
  const keystorePathFromEnv = process.env.ANDROID_KEYSTORE_PATH || '';
  const keyAlias = process.env.ANDROID_KEY_ALIAS || '';
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD || '';
  const keyPassword = process.env.ANDROID_KEY_PASSWORD || '';

  const hasInlineSigning = keystoreBase64 && keyAlias && storePassword && keyPassword;
  const hasFileSigning = keystorePathFromEnv && keyAlias && storePassword && keyPassword;
  if (!hasInlineSigning && !hasFileSigning) {
    return 0;
  }

  const keystoreTargetPath = path.join(androidRoot, 'keystore.jks');
  if (hasInlineSigning) {
    await fs.writeFile(keystoreTargetPath, Buffer.from(keystoreBase64, 'base64'));
  } else {
    await fs.copyFile(keystorePathFromEnv, keystoreTargetPath);
  }

  const keyPropertiesContent = [
    `storeFile=${keystoreTargetPath}`,
    `storePassword=${storePassword}`,
    `keyAlias=${keyAlias}`,
    `keyPassword=${keyPassword}`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(androidRoot, 'key.properties'), keyPropertiesContent, 'utf8');

  return 2;
}

async function main() {
  if (!(await exists(genRoot))) {
    console.log('[mobile-signing] skipped (src-tauri/gen does not exist yet)');
    process.exit(0);
  }

  const updates = await applyAndroidSigning();
  if (updates === 0) {
    console.log('[mobile-signing] no signing material provided');
    process.exit(0);
  }

  console.log(`[mobile-signing] updated ${updates} files`);
}

main().catch((error) => {
  console.error(`[mobile-signing] ${error.message}`);
  process.exit(1);
});
