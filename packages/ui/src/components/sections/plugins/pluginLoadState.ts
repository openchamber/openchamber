/**
 * Maps a plugin row in Settings to what OpenCode reports for it.
 *
 * The rules mirror OpenCode 2.x (`core/src/config/plugin/source.ts`,
 * `plugin/module.ts`, `plugin/supervisor.ts`):
 *
 * - A config string that is `file://…`, starts with `./` or `../`, or is
 *   absolute is a local path; relative ones resolve against the directory of
 *   the config file that declares them. Everything else (including `~/…`) is
 *   a package target, kept verbatim: `foo` and `foo@latest` are different
 *   targets and no `@latest` is implied.
 * - A package plugin reports `source.target` equal to that string.
 * - A local plugin that loaded reports its entrypoint file, which sits inside
 *   the configured directory (or is the file itself for a standalone plugin
 *   file); one that failed to load reports the configured path.
 */

import type { PluginRuntimeInfo } from '@/lib/opencode/plugins';

export type PluginRuntimeTarget =
  | { kind: 'package'; target: string }
  | { kind: 'local'; path: string };

export type PluginLoadState =
  /** OpenCode reported it and it is running. */
  | { kind: 'active'; version: string | null }
  /** OpenCode reported it and could not load it (or disabled it later). */
  | { kind: 'failed'; error: string; ref: string | null }
  /** A complete inventory arrived without it: still installing, disabled by a `-name` entry, or skipped. */
  | { kind: 'notReported' };

export type PluginUpdateFlag = 'none' | 'available' | 'updating';

const isAbsolutePath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

const normalizePath = (value: string): string => {
  const slashed = value.replace(/\\/g, '/');
  const segments: string[] = [];
  const [head, ...rest] = slashed.split('/');
  for (const segment of rest) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const root = /^[A-Za-z]:$/.test(head) ? `${head.toUpperCase()}/` : '/';
  return `${root}${segments.join('/')}`;
};

const dirname = (value: string): string => normalizePath(`${value.replace(/\\/g, '/')}/..`);

const fileUrlToPath = (value: string): string | null => {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
};

/**
 * What OpenCode will report for a config entry. `sourcePath` is the config
 * file that declares it; without it a relative path cannot be resolved and
 * the entry has no runtime identity.
 */
export function configEntryRuntimeTarget(spec: string, sourcePath: string | undefined): PluginRuntimeTarget | null {
  if (spec.startsWith('file://')) {
    const path = fileUrlToPath(spec);
    return path ? { kind: 'local', path: normalizePath(path) } : null;
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return sourcePath ? { kind: 'local', path: normalizePath(`${dirname(sourcePath)}/${spec}`) } : null;
  }
  if (isAbsolutePath(spec)) return { kind: 'local', path: normalizePath(spec) };
  return { kind: 'package', target: spec };
}

/** A plugin file or package directory OpenCode discovers from a `plugins/` folder. */
export function pluginFileRuntimeTarget(absolutePath: string | undefined): PluginRuntimeTarget | null {
  return absolutePath ? { kind: 'local', path: normalizePath(absolutePath) } : null;
}

const matches = (target: PluginRuntimeTarget, info: PluginRuntimeInfo): boolean => {
  if (target.kind === 'package') {
    return info.source.kind === 'package' && info.source.target === target.target;
  }
  if (info.source.kind !== 'local') return false;
  const reported = normalizePath(info.source.path);
  return reported === target.path || reported.startsWith(`${target.path}/`);
};

export function findRuntimeMatches(target: PluginRuntimeTarget, inventory: readonly PluginRuntimeInfo[]): PluginRuntimeInfo[] {
  return inventory.filter((info) => matches(target, info));
}

/**
 * A failure wins over an active match: when a new revision fails OpenCode
 * keeps the previous one running and reports both, and the failure is what
 * the user needs to see.
 */
export function resolveLoadState(matched: readonly PluginRuntimeInfo[]): PluginLoadState {
  const failed = matched.find((info) => info.state.kind === 'failed');
  if (failed && failed.state.kind === 'failed') {
    return { kind: 'failed', error: failed.state.error, ref: failed.state.ref };
  }
  const active = matched[0];
  if (!active) return { kind: 'notReported' };
  return { kind: 'active', version: active.source.kind === 'package' ? active.source.version : null };
}

export function resolveUpdateFlag(matched: readonly PluginRuntimeInfo[]): PluginUpdateFlag {
  const packages = matched.flatMap((info) => (info.source.kind === 'package' ? [info.source] : []));
  if (packages.some((source) => source.updating)) return 'updating';
  if (packages.some((source) => source.outdated)) return 'available';
  return 'none';
}
