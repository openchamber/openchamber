// Tools sources: what goes into a tools volume. A source is plain data, made once.
//
//   registry  exact published versions, for a released host
//   packed    local tarballs of `web` and `sdk`, for a development build, whose
//             packages differ from the published ones with the same version number
//
// Deciding which one a host needs is wiring and belongs to a later stage.

import crypto from 'node:crypto';
import fs from 'node:fs';

import { SpaceError } from './errors.js';
import { FILLER_PROGRAM } from './tools-filler.js';

// Where the filler puts the tarballs of a packed source. It is a tmpfs, so they vanish with the filler.
export const TOOLS_STAGING_PATH = '/tmp/openchamber-fill';

const WEB_TARBALL_NAME = 'openchamber-web.tgz';
const SDK_TARBALL_NAME = 'openchamber-sdk.tgz';

// Exact versions for the three packages this module names, never a range or a URL.
// That pins those three only. Their own dependencies are still ranges, and no lock file travels
// with the source, so two fills of one key can differ in a transitive package. A known limit.
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const requireVersion = (value, what) => {
  if (!EXACT_VERSION_PATTERN.test(value ?? '')) {
    throw new SpaceError('invalid_tools_version', `${what} needs an exact version such as 1.2.3, got '${value}'`);
  }
  return value;
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const packageJsonText = (fields) => JSON.stringify({ name: 'openchamber-space-tools', private: true, ...fields });

// Every source made here. The Docker place accepts no other object as a source.
const madeHere = new WeakSet();

const finishSource = (source) => {
  madeHere.add(Object.freeze(source));
  return source;
};

// A revision changes the key and nothing else: the same packages, filled again into a new volume.
const REVISION_PATTERN = /^[A-Za-z0-9._-]{0,64}$/;

const requireRevision = (value) => {
  if (!REVISION_PATTERN.test(value)) {
    throw new SpaceError('invalid_tools_revision', 'A tools revision may hold only letters, digits, dots, dashes and underscores, 64 at most');
  }
  return value;
};

/** OpenCode and its plugin always share one version. */
const openCodePackages = (version) => ({ '@opencode/cli': version, '@opencode/plugin': version });

/**
 * The versions a released host installs: its own `@openchamber/web`, and OpenCode at the
 * version of the `@opencode/client` this server was built against.
 */
export function readHostToolVersions(packageJsonUrl = new URL('../../../package.json', import.meta.url)) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8'));
  } catch (error) {
    throw new SpaceError('tools_versions_unreadable', `Could not read the package.json of the OpenChamber server: ${error.message}`);
  }
  return {
    webVersion: requireVersion(manifest.version, '@openchamber/web'),
    openCodeVersion: requireVersion(manifest.dependencies?.['@opencode/client'], 'OpenCode'),
  };
}

export function createRegistryToolsSource({ webVersion, openCodeVersion, revision = '' }) {
  const packages = {
    '@openchamber/web': requireVersion(webVersion, '@openchamber/web'),
    ...openCodePackages(requireVersion(openCodeVersion, 'OpenCode')),
  };
  return finishSource({
    kind: 'registry',
    description: `web ${webVersion}, opencode ${openCodeVersion}`,
    canonical: { kind: 'registry', packages, revision: requireRevision(revision) },
    packageJson: packageJsonText({ dependencies: packages }),
    files: [],
  });
}

/**
 * A development build. The two tarballs are read and hashed here, once.
 * The override makes every `@openchamber/sdk` in the tree the local tarball, also the one
 * that `web` asks for by version number.
 */
export function createPackedToolsSource({ webTarballPath, sdkTarballPath, openCodeVersion, revision = '' }) {
  const read = (filePath, what) => {
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      throw new SpaceError('tools_tarball_unreadable', `Could not read the packed ${what} package at ${filePath}: ${error.message}`);
    }
  };
  const files = [
    { name: WEB_TARBALL_NAME, bytes: read(webTarballPath, 'web') },
    { name: SDK_TARBALL_NAME, bytes: read(sdkTarballPath, 'sdk') },
  ];
  const packages = openCodePackages(requireVersion(openCodeVersion, 'OpenCode'));
  return finishSource({
    kind: 'packed',
    description: 'development build',
    canonical: { kind: 'packed', tarballs: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes) })), packages, revision: requireRevision(revision) },
    packageJson: packageJsonText({
      dependencies: {
        '@openchamber/web': `file:${TOOLS_STAGING_PATH}/${WEB_TARBALL_NAME}`,
        '@openchamber/sdk': `file:${TOOLS_STAGING_PATH}/${SDK_TARBALL_NAME}`,
        ...packages,
      },
      overrides: { '@openchamber/sdk': '$@openchamber/sdk' },
    }),
    files,
  });
}

export function requireToolsSource(source) {
  if (!madeHere.has(source)) {
    throw new SpaceError('invalid_tools_source', 'The Docker place needs a tools source from createRegistryToolsSource or createPackedToolsSource');
  }
  return source;
}

/**
 * First 16 hex characters of a sha256 over everything that decides the content of a tools
 * volume: the source, the base image the filler runs in, and the filler program itself.
 */
export function toolsContentKey(source, image) {
  const description = JSON.stringify({ source: requireToolsSource(source).canonical, image, filler: sha256(FILLER_PROGRAM) });
  return sha256(description).slice(0, 16);
}
