import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const buildRoot = path.join(desktopRoot, 'build');
const fdroidRoot = path.join(buildRoot, 'fdroid');
const repoDir = path.join(fdroidRoot, 'repo');
const metadataDir = path.join(fdroidRoot, 'metadata');
const androidArtifactsDir = path.join(buildRoot, 'mobile-artifacts', 'android');
const fallbackAndroidOutputsDir = path.join(desktopRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');

const appId = process.env.FDROID_APP_ID || 'ai.fedaykin.openchamber';
const appName = process.env.FDROID_APP_NAME || 'OpenChamber';
const appLicense = process.env.FDROID_APP_LICENSE || 'MIT';
const appSummary = process.env.FDROID_APP_SUMMARY || 'OpenChamber mobile release';
const appDescription = process.env.FDROID_APP_DESCRIPTION || 'OpenChamber mobile builds distributed through a custom F-Droid repository.';

const repoUrl = process.env.FDROID_REPO_URL || 'https://example.com/fdroid/repo';
const repoName = process.env.FDROID_REPO_NAME || 'OpenChamber';
const repoDescription = process.env.FDROID_REPO_DESCRIPTION || 'OpenChamber Android repository';
const repoKeyAlias = process.env.FDROID_REPO_KEY_ALIAS || 'repokey';
const repoKeyDName = process.env.FDROID_REPO_KEY_DNAME || '';

const keystoreBase64 = process.env.FDROID_KEYSTORE_BASE64 || '';
const keystorePass = process.env.FDROID_KEYSTORE_PASSWORD || '';
const keyPass = process.env.FDROID_KEY_PASSWORD || '';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function yamlValue(raw) {
  const value = String(raw ?? '');
  return JSON.stringify(value);
}

async function collectApks() {
  const roots = [];
  if (await exists(androidArtifactsDir)) {
    roots.push(androidArtifactsDir);
  }
  if (await exists(fallbackAndroidOutputsDir)) {
    roots.push(fallbackAndroidOutputsDir);
  }

  const found = [];
  for (const root of roots) {
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift();
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.apk')) {
          continue;
        }
        if (!entry.name.includes('release')) {
          continue;
        }
        found.push(fullPath);
      }
    }
  }

  const unique = Array.from(new Set(found));
  if (unique.length === 0) {
    throw new Error('No release APK files found. Build Android artifacts first.');
  }
  return unique;
}

async function writeMetadata() {
  const metadataPath = path.join(metadataDir, `${appId}.yml`);
  const content = [
    `Categories:`,
    `  - Development`,
    `License: ${yamlValue(appLicense)}`,
    `AuthorName: ${yamlValue(appName)}`,
    `WebSite: ${yamlValue('https://github.com/shekohex/openchamber')}`,
    `SourceCode: ${yamlValue('https://github.com/shekohex/openchamber')}`,
    `IssueTracker: ${yamlValue('https://github.com/shekohex/openchamber/issues')}`,
    `Summary: ${yamlValue(appSummary)}`,
    `Description: |-`,
    `  ${appDescription}`,
    '',
  ].join('\n');
  await fs.writeFile(metadataPath, content, 'utf8');
}

async function writeConfig() {
  const configLines = [
    `repo_url: ${yamlValue(repoUrl)}`,
    `repo_name: ${yamlValue(repoName)}`,
    `repo_description: ${yamlValue(repoDescription)}`,
    `repo_icon: ${yamlValue('icon.png')}`,
    `archive_older: 0`,
  ];

  const keystorePath = path.join(fdroidRoot, 'keystore.jks');
  const hasSigningConfig = keystoreBase64 && keystorePass && keyPass;
  if (hasSigningConfig) {
    await fs.writeFile(keystorePath, Buffer.from(keystoreBase64, 'base64'));
    configLines.push(`keystore: ${yamlValue('keystore.jks')}`);
    configLines.push(`keystorepass: ${yamlValue(keystorePass)}`);
    configLines.push(`keypass: ${yamlValue(keyPass)}`);
    configLines.push(`repo_keyalias: ${yamlValue(repoKeyAlias)}`);
    if (repoKeyDName) {
      configLines.push(`keydname: ${yamlValue(repoKeyDName)}`);
    }
  }

  configLines.push('');
  await fs.writeFile(path.join(fdroidRoot, 'config.yml'), configLines.join('\n'), 'utf8');
  return hasSigningConfig;
}

async function ensureRepoIcon() {
  const sourceIcon = path.join(desktopRoot, 'src-tauri', 'icons', 'icon.png');
  if (!(await exists(sourceIcon))) {
    return;
  }
  await fs.copyFile(sourceIcon, path.join(fdroidRoot, 'icon.png'));
}

async function main() {
  const apks = await collectApks();

  await fs.rm(fdroidRoot, { recursive: true, force: true });
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(metadataDir, { recursive: true });

  for (const apkPath of apks) {
    const targetPath = path.join(repoDir, path.basename(apkPath));
    await fs.copyFile(apkPath, targetPath);
  }

  await writeMetadata();
  const hasSigningConfig = await writeConfig();
  await ensureRepoIcon();

  const args = ['update', '--create-metadata', '--pretty'];
  if (!hasSigningConfig) {
    args.push('--nosign');
  }
  run('fdroid', args, fdroidRoot);

  const outputMarker = path.join(repoDir, 'index-v1.json');
  if (!(await exists(outputMarker))) {
    throw new Error('F-Droid repo generation failed: index-v1.json not found.');
  }

  console.log(`[fdroid] repository generated at ${repoDir}`);
  console.log(`[fdroid] signing ${hasSigningConfig ? 'enabled' : 'disabled (--nosign)'}`);
}

main().catch((error) => {
  console.error(`[fdroid] ${error.message}`);
  process.exit(1);
});
