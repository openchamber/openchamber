import path from 'path';
import { isString } from '../shared/object-guards.js';

export type ParsedNpmSpec = { name: string; version: string | null };
export type MalformedSpec = { malformed: true; raw: string };
export type ParsedPathSpec = { absolutePath: string };

export function parseNpmSpec<Spec>(spec: Spec): ParsedNpmSpec | MalformedSpec {
  if (!isString(spec)) {
    return { malformed: true, raw: String(spec) };
  }

  if (spec.startsWith('@')) {
    const slashIdx = spec.indexOf('/');
    if (slashIdx < 2) return { malformed: true, raw: spec };
    const afterSlash = spec.slice(slashIdx + 1);
    if (afterSlash === '') return { malformed: true, raw: spec };
    const atIdx = afterSlash.indexOf('@');
    if (atIdx === -1) return { name: spec, version: null };
    const namePart = spec.slice(0, slashIdx + 1 + atIdx);
    const versionPart = afterSlash.slice(atIdx + 1);
    if (versionPart === '') return { malformed: true, raw: spec };
    return { name: namePart, version: versionPart };
  }

  if (spec === '') return { malformed: true, raw: spec };
  const atIdx = spec.indexOf('@');
  if (atIdx === -1) return { name: spec, version: null };
  if (atIdx === 0) return { malformed: true, raw: spec };
  const namePart = spec.slice(0, atIdx);
  const versionPart = spec.slice(atIdx + 1);
  if (versionPart === '') return { malformed: true, raw: spec };
  return { name: namePart, version: versionPart };
}

export function isExactSemver(version: string) {
  return /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version);
}

export function isPathSpec(spec: string) {
  return spec.startsWith('/')
    || spec.startsWith('./')
    || spec.startsWith('../')
    || spec.startsWith('~')
    || path.win32.isAbsolute(spec);
}

export function isGitSpec(spec: string) {
  if (/^(?:github|gitlab|bitbucket|gist):[^\s]+$/i.test(spec)) return true;
  if (/^git\+(?:https?|ssh|file):\/\/[^\s]+$/i.test(spec)) return true;
  if (/^git:\/\/[^\s]+$/i.test(spec)) return true;
  return false;
}

export function isPluginControlSpec(spec: string) {
  if (spec.startsWith('-')) return spec.length > 1;
  return spec === '*' || spec.endsWith('.*') || spec.startsWith('opencode.');
}

export function parsedKindForSpec(spec: string) {
  if (isPluginControlSpec(spec)) return 'control';
  if (isPathSpec(spec)) return 'path';
  if (isGitSpec(spec)) return 'git';
  return 'npm';
}

export function parsePathSpec(spec: string, { homedir, cwd }: { homedir: string; cwd: string }): ParsedPathSpec {
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
