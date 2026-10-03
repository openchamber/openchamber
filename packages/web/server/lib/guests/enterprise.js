import { requestedGuestCapabilities } from '@openchamber/sdk';

import { readEnterprisePolicy } from '../enterprise-mode.js';

/**
 * Enterprise mode and extensions. An extension that can send what it sees
 * off this machine answers to the administrator:
 * - `network`: host requests to its integration's API origin;
 * - `origins`: its frame fetching approved https origins directly;
 * - `service`: an unsandboxed process with the user's access.
 * Such a package installs and runs only from a Git repository listed in the
 * policy (`allowedExtensions`; an entry ending in `/` allows every
 * repository under it, such as a whole organization), or from a local folder
 * where `allowLocalExtensions` is set for developers. ZIP stays closed:
 * it is how a build gets handed to others. Everything else installs as usual.
 * The list names repositories, not package ids: a package declares its own
 * id, so an id would let a user ship any code under an allowed name.
 */
const ENTERPRISE_GATED_CAPABILITIES = ['network', 'origins', 'service'];

/** `host/path` of a clone URL (https or scp-style ssh), for comparing two spellings of one repository. */
const repositoryKey = (value) => {
  const trimmed = String(value).trim().replace(/#.*$/, '');
  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  let host;
  let pathname;
  if (scp) {
    [, host, pathname] = scp;
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

const isAllowedRepository = (gitUrl, allowed) => {
  const key = gitUrl ? repositoryKey(gitUrl) : null;
  if (key === null) return false;
  return allowed.some((entry) => {
    const allowedKey = repositoryKey(entry);
    if (allowedKey === null) return false;
    // A trailing slash allows everything under it; matching on the separator
    // keeps `acme/` from also allowing `acme-other/`.
    return entry.trim().endsWith('/') ? key.startsWith(`${allowedKey}/`) : key === allowedKey;
  });
};

/**
 * The gated capabilities `guest` asks for that enterprise mode refuses, given
 * where it comes from (`source`, and the clone URL for Git installs). Empty
 * outside enterprise mode, for packages that ask for none, and for packages
 * from an allowed repository. A caller checking many packages reads the
 * policy once and passes it in.
 */
export const enterpriseBlockedCapabilities = (guest, { source, gitUrl } = {}, policy = readEnterprisePolicy()) => {
  if (!policy.enterpriseMode) return [];
  const gated = requestedGuestCapabilities(guest).filter((capability) => ENTERPRISE_GATED_CAPABILITIES.includes(capability));
  if (gated.length === 0) return [];
  if (source === 'git' && isAllowedRepository(gitUrl, policy.allowedExtensions)) return [];
  if (source === 'path' && policy.allowLocalExtensions) return [];
  return gated;
};
