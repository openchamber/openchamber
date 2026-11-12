import { isPathSpec, isPluginControlSpec } from './plugin-spec.js';

// The forms OpenCode 2 loads from the `plugins` config list. OpenCode installs
// anything that is not a path with npm's own spec parser and accepts only a
// registry package (name with an optional version, tag or range) or a Git
// spec; see `Npm.isInstallablePackage` in OpenCode's `packages/util/src/npm.ts`.

// npm package names, scoped or not. Upper case is still valid for old packages.
const NPM_NAME = String.raw`(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*`;
// A version, dist-tag or semver range after the name: `1.2.3`, `next`, `^1`, `>=1 <2`, `1.x || 2.x`.
const NPM_VERSION = String.raw`[\w.*^~<>=|+ -]*[\w*]`;
const NPM_SPEC_PATTERN = new RegExp(`^${NPM_NAME}(?:@${NPM_VERSION})?$`, 'i');
const NPM_NAME_MAX_LENGTH = 214;

const GIT_SPEC_PATTERNS = [
  // Hosted shortcuts: `github:owner/repo#ref`, also GitLab, Bitbucket and gists.
  /^(?:github|gitlab|bitbucket|gist):\S+$/i,
  // Git transports: `git+https://…`, `git+ssh://…`, `git+file://…`, `git://…`.
  /^git(?:\+(?:https?|ssh|file))?:\/\/\S+$/i,
  // scp-style SSH: `git@github.com:owner/repo.git`. The host has a dot, so an
  // npm alias such as `name@npm:other` does not match.
  /^[\w.-]+@[\w-]+(?:\.[\w-]+)+:\S+$/,
  // GitHub shorthand: `owner/repo#ref`.
  /^[\w.-]+\/[\w.-]+(?:#\S+)?$/,
];

// A plain `https://` repository address. npm reads it as Git, but OpenCode
// 2.0.32 resolves it as a folder name and fails on every start, so it is
// written in the `git+https://` form, which OpenCode installs. Only addresses
// that name a repository without doubt are rewritten: a repository on a known
// host, or any address ending in `.git`. A page inside a repository
// (`/tree/main`) or a download link stays unloadable.
const HTTPS_REPOSITORY_PATTERNS = [
  /^https:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:#\S+)?$/i,
  /^https:\/\/[^\s/#]+\/[^\s#]+\.git(?:#\S+)?$/i,
];

function isNpmPackageSpec(spec) {
  if (!NPM_SPEC_PATTERN.test(spec)) return false;
  const versionAt = spec.indexOf('@', 1);
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt);
  return name.length <= NPM_NAME_MAX_LENGTH;
}

/**
 * Return the plugin spec in the form OpenCode 2 loads, or null when it loads
 * no form of it.
 *
 * A control entry (`-name`, `*`, `prefix.*`) is returned unchanged: OpenCode
 * applies it to plugins it already knows and loads nothing for it.
 *
 * Local paths (including `file://` URLs) are returned unchanged: OpenCode
 * reads them from disk and whether the folder exists is checked there. A
 * plain `https://` repository address is rewritten to `git+https://`.
 *
 * @param {string} spec trimmed, non-empty
 * @returns {string | null}
 */
export function toLoadablePluginSpec(spec) {
  if (isPluginControlSpec(spec)) return spec;
  if (isPathSpec(spec) || spec.startsWith('file://')) return spec;
  if (isNpmPackageSpec(spec)) return spec;
  if (GIT_SPEC_PATTERNS.some((pattern) => pattern.test(spec))) return spec;
  if (HTTPS_REPOSITORY_PATTERNS.some((pattern) => pattern.test(spec))) return `git+${spec}`;
  return null;
}
