
import crypto from 'node:crypto';
import fs from 'node:fs';
import { webPackagePaths } from '../web-package-paths.js';

import { SpaceError } from './errors.js';
import { FILLER_PROGRAM } from './tools-filler.js';
import { requiredFailureProperty as failureProperty } from './failure.js';
import type { ToolsFile } from './tools-filler.js';
import { parseJson } from './json.js';
import type { JsonValue } from './json.js';

export const TOOLS_STAGING_PATH = '/tmp/openchamber-fill';

const WEB_TARBALL_NAME = 'openchamber-web.tgz';
const SDK_TARBALL_NAME = 'openchamber-sdk.tgz';

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const requireVersion = <Value>(value: Value, what: string) => {
  if (!EXACT_VERSION_PATTERN.test(`${value ?? ''}`)) {
    throw new SpaceError('invalid_tools_version', `${what} needs an exact version such as 1.2.3, got '${value}'`);
  }
  return value;
};

const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

const packageJsonText = <Fields extends object>(fields: Fields) => JSON.stringify({ name: 'openchamber-space-tools', private: true, ...fields });

const madeHere = new WeakSet();

const finishSource = <Source extends object>(source: Source) => {
  madeHere.add(Object.freeze(source));
  return source;
};

const REVISION_PATTERN = /^[A-Za-z0-9._-]{0,64}$/;

const requireRevision = (value: string) => {
  if (!REVISION_PATTERN.test(value)) {
    throw new SpaceError('invalid_tools_revision', 'A tools revision may hold only letters, digits, dots, dashes and underscores, 64 at most');
  }
  return value;
};

const openCodePackages = <Version>(version: Version) => ({ '@opencode/cli': version, '@opencode/plugin': version });

const RUNTIME_PACKAGES = Object.freeze({ bun: '1.4.4', pnpm: '12.11.2' });

export function readHostToolVersions(packageJsonUrl = webPackagePaths.packageJson) {
  let manifest: JsonValue;
  try {
    manifest = parseJson(fs.readFileSync(packageJsonUrl, 'utf8'));
  } catch (error) {
    throw new SpaceError('tools_versions_unreadable', `Could not read the package.json of the OpenChamber server: ${failureProperty(error, 'message')}`);
  }
  if (manifest === null || manifest === undefined) throw new TypeError(`Cannot read properties of ${manifest} (reading 'version')`);
  const fields: unknown = Object(manifest);
  const dependencies: unknown = Object(isVersionManifest(fields) ? fields.dependencies : undefined);
  return {
    webVersion: requireVersion(isVersionManifest(fields) ? fields.version : undefined, '@openchamber/web'),
    openCodeVersion: requireVersion(isVersionDependencies(dependencies) ? dependencies['@opencode/client'] : undefined, 'OpenCode'),
  };
}

const isVersionManifest = (value: unknown): value is { version?: unknown; dependencies?: unknown } => value instanceof Object;
const isVersionDependencies = (value: unknown): value is { '@opencode/client'?: unknown } => value instanceof Object;

export function createRegistryToolsSource({ webVersion, openCodeVersion, revision = '' }: { webVersion: unknown; openCodeVersion: unknown; revision?: string }) {
  const files: ToolsFile[] = [];
  const packages = {
    '@openchamber/web': requireVersion(webVersion, '@openchamber/web'),
    ...openCodePackages(requireVersion(openCodeVersion, 'OpenCode')),
    ...RUNTIME_PACKAGES,
  };
  return finishSource({
    kind: 'registry',
    description: `web ${webVersion}, opencode ${openCodeVersion}`,
    canonical: { kind: 'registry', packages, revision: requireRevision(revision) },
    packageJson: packageJsonText({ dependencies: packages }),
    files,
  });
}

export function createPackedToolsSource({ webTarballPath, sdkTarballPath, openCodeVersion, revision = '' }: { webTarballPath: string; sdkTarballPath: string; openCodeVersion: unknown; revision?: string }) {
  const read = (filePath: string, what: string) => {
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      throw new SpaceError('tools_tarball_unreadable', `Could not read the packed ${what} package at ${filePath}: ${failureProperty(error, 'message')}`);
    }
  };
  const files = [
    { name: WEB_TARBALL_NAME, bytes: read(webTarballPath, 'web') },
    { name: SDK_TARBALL_NAME, bytes: read(sdkTarballPath, 'sdk') },
  ];
  const packages = { ...openCodePackages(requireVersion(openCodeVersion, 'OpenCode')), ...RUNTIME_PACKAGES };
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

export type ToolsSource = ReturnType<typeof createRegistryToolsSource> | ReturnType<typeof createPackedToolsSource>;

export function requireToolsSource(source: ToolsSource) {
  if (!madeHere.has(source)) {
    throw new SpaceError('invalid_tools_source', 'The Docker place needs a tools source from createRegistryToolsSource or createPackedToolsSource');
  }
  return source;
}

export function toolsContentKey(source: ToolsSource, image: string) {
  const description = JSON.stringify({ source: requireToolsSource(source).canonical, image, filler: sha256(FILLER_PROGRAM) });
  return sha256(description).slice(0, 16);
}
