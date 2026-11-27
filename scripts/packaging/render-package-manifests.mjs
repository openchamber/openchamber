#!/usr/bin/env node
// Renders the package-manager listings of a stable release from the files
// already on its GitHub release: the winget manifests and the Homebrew cask.
//
//   node scripts/packaging/render-package-manifests.mjs --version 2.7.2 --dir <release files> --out <dir>
//
// <release files> holds the release's `OpenChamber-<version>-*` installers.
// The checksums come from those files, so a listing never names a file that
// was not built. Output: `<out>/winget/manifests/o/OpenChamber/OpenChamber/<version>/`
// (the layout microsoft/winget-pkgs expects) and `<out>/homebrew/Casks/openchamber.rb`.
// scripts/packaging/DOCUMENTATION.md says who publishes them and where.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'openchamber/openchamber';
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const HOMEPAGE = 'https://openchamber.dev';
const DESCRIPTION = 'Desktop app for OpenCode';

export const WINGET_ID = 'OpenChamber.OpenChamber';
const WINGET_SCHEMA = 'https://aka.ms/winget-manifest';
const WINGET_MANIFEST_VERSION = '1.10.0';

const WINDOWS_INSTALLERS = [
  { architecture: 'x64', file: (version) => `OpenChamber-${version}-win-x64.exe` },
  { architecture: 'arm64', file: (version) => `OpenChamber-${version}-win-arm64.exe` },
];
const MAC_DMGS = {
  arm: (version) => `OpenChamber-${version}-mac-arm64.dmg`,
  intel: (version) => `OpenChamber-${version}-mac-x64.dmg`,
};

const releaseUrl = (version, file) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;

export const sha256File = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex');

export const assertStableVersion = (version) => {
  if (!STABLE_VERSION.test(version ?? '')) {
    throw new Error(`Package managers list stable releases only, got version: ${version}`);
  }
};

export const wingetManifestDirectory = (version) => path.posix.join('manifests', 'o', 'OpenChamber', 'OpenChamber', version);

const checksumOf = (sha256, name) => {
  const hash = sha256[name];
  if (!hash) throw new Error(`No checksum for ${name}`);
  return hash;
};

// `sha256` maps an installer file name to its hex SHA-256.
export const renderWingetManifests = (version, sha256) => {
  assertStableVersion(version);
  const header = (type) => `# yaml-language-server: $schema=${WINGET_SCHEMA}.${type}.${WINGET_MANIFEST_VERSION}.schema.json\n`;

  const versionManifest = `${header('version')}PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;

  const installers = WINDOWS_INSTALLERS.map(({ architecture, file }) => {
    const name = file(version);
    return `- Architecture: ${architecture}
  InstallerUrl: ${releaseUrl(version, name)}
  InstallerSha256: ${checksumOf(sha256, name).toUpperCase()}`;
  }).join('\n');

  const installerManifest = `${header('installer')}PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
UpgradeBehavior: install
Installers:
${installers}
ManifestType: installer
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;

  const localeManifest = `${header('defaultLocale')}PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: OpenChamber
PublisherUrl: ${HOMEPAGE}
PublisherSupportUrl: https://github.com/${REPOSITORY}/issues
PackageName: OpenChamber
PackageUrl: ${HOMEPAGE}
License: MIT
LicenseUrl: https://github.com/${REPOSITORY}/blob/v${version}/LICENSE
ShortDescription: ${DESCRIPTION}
Tags:
- opencode
- ai
- coding-agent
ReleaseNotesUrl: https://github.com/${REPOSITORY}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;

  return {
    [`${WINGET_ID}.yaml`]: versionManifest,
    [`${WINGET_ID}.installer.yaml`]: installerManifest,
    [`${WINGET_ID}.locale.en-US.yaml`]: localeManifest,
  };
};

export const renderHomebrewCask = (version, sha256) => {
  assertStableVersion(version);
  const arm = checksumOf(sha256, MAC_DMGS.arm(version)).toLowerCase();
  const intel = checksumOf(sha256, MAC_DMGS.intel(version)).toLowerCase();

  return `cask "openchamber" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm}",
         intel: "${intel}"

  url "https://github.com/${REPOSITORY}/releases/download/v#{version}/OpenChamber-#{version}-mac-#{arch}.dmg"
  name "OpenChamber"
  desc "${DESCRIPTION}"
  homepage "${HOMEPAGE}"

  auto_updates true

  app "OpenChamber.app"

  zap trash: [
    "~/Library/Application Support/OpenChamber",
    "~/Library/Logs/OpenChamber",
    "~/Library/Preferences/dev.openchamber.desktop.plist",
  ]
end
`;
};

const readOptions = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--version', '--dir', '--out'].includes(flag) || argv[index + 1] === undefined) {
      throw new Error('Usage: render-package-manifests.mjs --version <x.y.z> --dir <release files> --out <dir>');
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  for (const required of ['version', 'dir', 'out']) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  return options;
};

const main = () => {
  const { version, dir, out } = readOptions(process.argv.slice(2));
  assertStableVersion(version);

  const names = [...WINDOWS_INSTALLERS.map(({ file }) => file(version)), ...Object.values(MAC_DMGS).map((file) => file(version))];
  const sha256 = Object.fromEntries(names.map((name) => [name, sha256File(path.join(dir, name))]));

  const wingetDir = path.join(out, 'winget', wingetManifestDirectory(version));
  mkdirSync(wingetDir, { recursive: true });
  for (const [name, content] of Object.entries(renderWingetManifests(version, sha256))) {
    writeFileSync(path.join(wingetDir, name), content);
  }

  const caskDir = path.join(out, 'homebrew', 'Casks');
  mkdirSync(caskDir, { recursive: true });
  writeFileSync(path.join(caskDir, 'openchamber.rb'), renderHomebrewCask(version, sha256));
  console.log(`Rendered winget manifests and the Homebrew cask for ${version} in ${out}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
