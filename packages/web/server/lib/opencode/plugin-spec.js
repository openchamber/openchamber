import path from 'path';

/**
 * @typedef {Object} ParsedNpmSpec
 * @property {string} name
 * @property {string|null} version
 */

/**
 * @typedef {Object} MalformedSpec
 * @property {true} malformed
 * @property {string} raw
 */

/**
 * @typedef {Object} ParsedPathSpec
 * @property {string} absolutePath
 */

/**
 * Parse an npm package spec string into name + version.
 * Handles scoped packages (`@scope/name[@version]`) and unscoped (`name[@version]`).
 * Non-string inputs are coerced via `String()` and returned as malformed.
 *
 * @param {unknown} spec
 * @returns {ParsedNpmSpec | MalformedSpec}
 */
export function parseNpmSpec(spec) {
  if (typeof spec !== 'string') {
    return { malformed: true, raw: String(spec) };
  }

  if (spec.startsWith('@')) {
    // scoped: '@scope/name' or '@scope/name@version'
    const slashIdx = spec.indexOf('/');
    if (slashIdx < 2) return { malformed: true, raw: spec }; // '@' or '@/foo'
    const afterSlash = spec.slice(slashIdx + 1);
    if (afterSlash === '') return { malformed: true, raw: spec }; // '@scope/'
    const atIdx = afterSlash.indexOf('@');
    if (atIdx === -1) return { name: spec, version: null };
    const namePart = spec.slice(0, slashIdx + 1 + atIdx); // '@scope/name'
    const versionPart = afterSlash.slice(atIdx + 1);
    if (versionPart === '') return { malformed: true, raw: spec }; // '@scope/foo@'
    return { name: namePart, version: versionPart };
  }

  // unscoped
  if (spec === '') return { malformed: true, raw: spec };
  const atIdx = spec.indexOf('@');
  if (atIdx === -1) return { name: spec, version: null };
  if (atIdx === 0) return { malformed: true, raw: spec }; // bare '@'
  const namePart = spec.slice(0, atIdx);
  const versionPart = spec.slice(atIdx + 1);
  if (versionPart === '') return { malformed: true, raw: spec }; // 'foo@'
  return { name: namePart, version: versionPart };
}

/**
 * Check whether a version string is an exact semver (no range operators).
 * Accepts optional pre-release (`-label`) or build metadata (`+label`) suffixes.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isExactSemver(version) {
  return /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version);
}

/**
 * Check whether a plugin spec is path-like instead of an npm package spec.
 * Includes Windows absolute paths so local paths are never queried against npm.
 *
 * @param {string} spec
 * @returns {boolean}
 */
export function isPathSpec(spec) {
  return spec.startsWith('/')
    || spec.startsWith('./')
    || spec.startsWith('../')
    || spec.startsWith('~')
    || path.win32.isAbsolute(spec);
}

/**
 * Resolve a path-style plugin spec to an absolute path.
 * Supports `~` (home), `./`, `../` (relative to cwd), and absolute paths.
 * Pure — no filesystem access; uses only `path.resolve`.
 *
 * @param {string} spec
 * @param {{ homedir: string, cwd: string }} options
 * @returns {ParsedPathSpec}
 */
export function parsePathSpec(spec, { homedir, cwd }) {
  if (spec === '~') {
    return { absolutePath: path.resolve(homedir) };
  }
  if (spec.startsWith('~/')) {
    return { absolutePath: path.resolve(homedir, spec.slice(2)) };
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return { absolutePath: path.resolve(cwd, spec) };
  }
  if (path.win32.isAbsolute(spec)) {
    return { absolutePath: spec };
  }
  return { absolutePath: path.resolve(spec) };
}
