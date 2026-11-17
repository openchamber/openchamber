
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'yaml';
import { z } from 'zod';

import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { ghConfigDir } from './gh-config.js';

const dataDir = () => process.env.OPENCHAMBER_DATA_DIR
  ? resolve(process.env.OPENCHAMBER_DATA_DIR)
  : join(homedir(), '.config', 'openchamber');

const normalizeHost = (value) => String(value ?? '').trim().toLowerCase();

const hostEntrySchema = z.object({
  oauth_token: z.string().optional(),
  user: z.string().optional(),
  users: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (entry) => Boolean(entry.oauth_token) || Boolean(entry.user)
    || (entry.users !== undefined && Object.keys(entry.users).length > 0),
).nullable();
const hostsDocSchema = z.record(z.string(), z.unknown()).nullable();

const loadHostsYaml = () => {
  try {
    const parsed = yaml.parse(readFileSync(join(ghConfigDir(), 'hosts.yml'), 'utf8'));
    const result = hostsDocSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    const normalized = {};
    for (const [host, entry] of Object.entries(result.data)) {
      normalized[normalizeHost(host)] = entry;
    }
    return normalized;
  } catch {
    return null;
  }
};

const hasStoredLogin = (entry) => {
  const parsed = hostEntrySchema.safeParse(entry);
  return Boolean(parsed.success && parsed.data);
};

export function isTrustedGitHubHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === 'github.com') {
    return true;
  }
  const envHost = normalizeHost(process.env.GH_HOST);
  if (envHost && envHost === normalized) {
    return true;
  }
  return hasStoredLogin(loadHostsYaml()?.[normalized]);
}

export async function isTrustedGitHubHostOrStored(host) {
  const normalized = normalizeHost(host);
  if (isTrustedGitHubHost(normalized)) return true;
  const authStore = createSourceControlAuthStore({ filePath: join(dataDir(), 'source-control-auth.json') });
  const instance = await authStore.github.readInstance(normalized);
  return (instance?.accounts?.length ?? 0) > 0;
}

export function hasStoredGhLogin(host) {
  return hasStoredLogin(loadHostsYaml()?.[normalizeHost(host)]);
}

export function storedGhLogins(host) {
  const parsed = hostEntrySchema.safeParse(loadHostsYaml()?.[normalizeHost(host)]);
  if (!parsed.success || !parsed.data) return { active: null, logins: [] };
  const logins = [];
  const add = (login) => {
    const value = (login ?? '').trim();
    if (value && !logins.some((existing) => existing.toLowerCase() === value.toLowerCase())) logins.push(value);
  };
  add(parsed.data.user);
  for (const login of Object.keys(parsed.data.users ?? {})) add(login);
  return { active: logins[0] ?? null, logins };
}

export function storedGhLoginUser(host) {
  const { active } = storedGhLogins(host);
  return active === null ? null : { id: 0, login: active };
}

export function listTrustedGitHubHosts() {
  const hostsDoc = loadHostsYaml();
  const hosts = [];
  if (hostsDoc) {
    for (const [host, entry] of Object.entries(hostsDoc)) {
      if (host !== 'github.com' && hasStoredLogin(entry)) hosts.push(host);
    }
  }
  const envHost = normalizeHost(process.env.GH_HOST);
  if (envHost && envHost !== 'github.com' && !hosts.includes(envHost)) {
    hosts.push(envHost);
  }
  return hosts.sort();
}
