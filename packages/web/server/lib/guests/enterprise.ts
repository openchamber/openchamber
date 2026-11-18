import { requestedGuestCapabilities } from '@openchamber/sdk';
import type { OpenChamberManifest } from '@openchamber/sdk';

import { readEnterprisePolicy } from '../enterprise-mode.js';

const ENTERPRISE_GATED_CAPABILITIES = ['network', 'origins', 'service', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions', 'skills', 'opencodePlugin', 'opencode'];

const repositoryKey = (value: string) => {
  const trimmed = String(value).trim().replace(/#.*$/, '');
  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  let host;
  let pathname;
  if (scp) {
    host = scp[1] ?? '';
    pathname = scp[2] ?? '';
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }
  const cleanPath = pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return cleanPath ? `${host.toLowerCase()}/${cleanPath}` : null;
};

const isAllowedRepository = (gitUrl: string | undefined, allowed: string[]) => {
  const key = gitUrl ? repositoryKey(gitUrl) : null;
  if (key === null) return false;
  return allowed.some((entry) => {
    const allowedKey = repositoryKey(entry);
    if (allowedKey === null) return false;
    return entry.trim().endsWith('/') ? key.startsWith(`${allowedKey}/`) : key === allowedKey;
  });
};

export const enterpriseBlockedCapabilities = (guest: Partial<OpenChamberManifest['contributes']>, { source, gitUrl }: { source?: string; gitUrl?: string | undefined } = {}, policy = readEnterprisePolicy()) => {
  if (!policy.enterpriseMode) return [];
  const gated = requestedGuestCapabilities(guest).filter((capability) => ENTERPRISE_GATED_CAPABILITIES.includes(capability));
  if (gated.length === 0) return [];
  if (source === 'git' && isAllowedRepository(gitUrl, policy.allowedExtensions)) return [];
  if (source === 'path' && policy.allowLocalExtensions) return [];
  return gated;
};
