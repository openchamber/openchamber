import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SOCKET_PLATFORMS = new Set(['linux', 'darwin', 'win32']);

/**
 * @param {string} value
 * @param {string} [home]
 */
export const expandHomePath = (value, home = process.env.HOME || os.homedir()) => {
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
};

/**
 * @param {{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }} binding
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
export const platformSocketCandidates = (
  binding,
  platform = process.platform,
  home = process.env.HOME || os.homedir(),
) => {
  if (!SOCKET_PLATFORMS.has(platform)) {
    return [];
  }
  const list = binding.candidatesByPlatform?.[platform] ?? [];
  return list.map((entry) => expandHomePath(entry, home));
};

/**
 * @param {{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }} binding
 * @param {{
 *   override?: string | null,
 *   platform?: NodeJS.Platform,
 *   access?: (candidate: string) => Promise<void>,
 *   home?: string,
 * }} [options]
 * @returns {Promise<string | null>}
 */
export const resolveSocketBinding = async (binding, options = {}) => {
  const {
    override = null,
    platform = process.platform,
    access = (candidate) => fs.access(candidate),
    home = process.env.HOME || os.homedir(),
  } = options;
  if (typeof override === 'string' && override.trim()) {
    return expandHomePath(override.trim(), home);
  }
  for (const candidate of platformSocketCandidates(binding, platform, home)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
};

/**
 * @param {Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>} bindings
 * @param {Record<string, string>} [overrides]
 * @param {{
 *   platform?: NodeJS.Platform,
 *   access?: (candidate: string) => Promise<void>,
 *   home?: string,
 * }} [options]
 */
export const buildPublicSocketBindings = async (bindings, overrides = {}, options = {}) => {
  const {
    platform = process.platform,
    access,
    home = process.env.HOME || os.homedir(),
  } = options;
  /** @type {Array<{ id: string, candidates: string[], resolved: string | null, override: string | null }>} */
  const out = [];
  for (const binding of bindings) {
    const rawOverride = overrides[binding.id];
    const override = typeof rawOverride === 'string' && rawOverride.trim()
      ? expandHomePath(rawOverride.trim(), home)
      : null;
    const candidates = platformSocketCandidates(binding, platform, home);
    const resolved = await resolveSocketBinding(binding, {
      override: rawOverride,
      platform,
      access,
      home,
    });
    out.push({
      id: binding.id,
      candidates,
      resolved,
      override,
    });
  }
  return out;
};

/**
 * @param {Array<{ id: string, candidatesByPlatform?: Partial<Record<'linux' | 'darwin' | 'win32', string[]>> }>} bindings
 * @param {Record<string, string>} [overrides]
 * @param {{
 *   platform?: NodeJS.Platform,
 *   access?: (candidate: string) => Promise<void>,
 *   home?: string,
 * }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export const resolveAgentSocketEnv = async (bindings, overrides = {}, options = {}) => {
  const publicBindings = await buildPublicSocketBindings(bindings, overrides, options);
  /** @type {Record<string, string>} */
  const sockets = {};
  for (const binding of publicBindings) {
    if (!binding.resolved) {
      continue;
    }
    sockets[binding.id] = binding.resolved;
  }
  return sockets;
};
