import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SocketBinding as ManifestSocketBinding, PublicSocketBinding } from '@openchamber/sdk';
import { isString } from './input-guards.js';

type SocketBinding = Pick<ManifestSocketBinding, 'id'> & Partial<Pick<ManifestSocketBinding, 'candidatesByPlatform'>>;
type SocketOptions = {
  platform?: NodeJS.Platform;
  access?: ((candidate: string) => Promise<void>) | undefined;
  home?: string;
};
type BindingOptions = SocketOptions & { override?: string | null | undefined };

const SOCKET_PLATFORMS = new Set(['linux', 'darwin', 'win32']);
const isSocketPlatform = (platform: NodeJS.Platform): platform is 'linux' | 'darwin' | 'win32' => SOCKET_PLATFORMS.has(platform);

export const expandHomePath = (value: string, home = process.env.HOME || os.homedir()) => {
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const platformSocketCandidates = (
  binding: SocketBinding,
  platform = process.platform,
  home = process.env.HOME || os.homedir(),
) => {
  if (!isSocketPlatform(platform)) {
    return [];
  }
  const list = binding.candidatesByPlatform?.[platform] ?? [];
  return list.map((entry) => expandHomePath(entry, home));
};

export const resolveSocketBinding = async (binding: SocketBinding, options: BindingOptions = {}) => {
  const {
    override = null,
    platform = process.platform,
    access = (candidate: string) => fs.access(candidate),
    home = process.env.HOME || os.homedir(),
  } = options;
  if (isString(override) && override.trim()) {
    return expandHomePath(override.trim(), home);
  }
  for (const candidate of platformSocketCandidates(binding, platform, home)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

export const buildPublicSocketBindings = async (bindings: SocketBinding[], overrides: Record<string, string> = {}, options: SocketOptions = {}) => {
  const {
    platform = process.platform,
    access,
    home = process.env.HOME || os.homedir(),
  } = options;
  const out: PublicSocketBinding[] = [];
  for (const binding of bindings) {
    const rawOverride = overrides[binding.id];
    const override = isString(rawOverride) && rawOverride.trim()
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

export const resolveServiceSocketEnv = async (bindings: SocketBinding[], overrides: Record<string, string> = {}, options: SocketOptions = {}): Promise<Record<string, string>> => {
  const publicBindings = await buildPublicSocketBindings(bindings, overrides, options);
  const sockets: Record<string, string> = {};
  for (const binding of publicBindings) {
    if (!binding.resolved) {
      continue;
    }
    sockets[binding.id] = binding.resolved;
  }
  return sockets;
};
