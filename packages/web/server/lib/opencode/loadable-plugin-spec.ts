import { isPathSpec, isPluginControlSpec } from './plugin-spec.js';


const NPM_NAME = String.raw`(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*`;
const NPM_VERSION = String.raw`[\w.*^~<>=|+ -]*[\w*]`;
const NPM_SPEC_PATTERN = new RegExp(`^${NPM_NAME}(?:@${NPM_VERSION})?$`, 'i');
const NPM_NAME_MAX_LENGTH = 214;

const GIT_SPEC_PATTERNS = [
  /^(?:github|gitlab|bitbucket|gist):\S+$/i,
  /^git(?:\+(?:https?|ssh|file))?:\/\/\S+$/i,
  /^[\w.-]+@[\w-]+(?:\.[\w-]+)+:\S+$/,
  /^[\w.-]+\/[\w.-]+(?:#\S+)?$/,
];

const HTTPS_REPOSITORY_PATTERNS = [
  /^https:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:#\S+)?$/i,
  /^https:\/\/[^\s/#]+\/[^\s#]+\.git(?:#\S+)?$/i,
];

function isNpmPackageSpec(spec: string) {
  if (!NPM_SPEC_PATTERN.test(spec)) return false;
  const versionAt = spec.indexOf('@', 1);
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt);
  return name.length <= NPM_NAME_MAX_LENGTH;
}

export function toLoadablePluginSpec(spec: string) {
  if (isPluginControlSpec(spec)) return spec;
  if (isPathSpec(spec) || spec.startsWith('file://')) return spec;
  if (isNpmPackageSpec(spec)) return spec;
  if (GIT_SPEC_PATTERNS.some((pattern) => pattern.test(spec))) return spec;
  if (HTTPS_REPOSITORY_PATTERNS.some((pattern) => pattern.test(spec))) return `git+${spec}`;
  return null;
}
