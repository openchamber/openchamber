import type { InstalledGuest } from './types';

/** Turns the recorded clone origin into a browser link, without Git credentials or refs. */
export const getGuestSourceUrl = (guest: InstalledGuest): string | null => {
  if (guest.source !== 'git' || !guest.origin?.url) return null;
  const origin = guest.origin.url.trim();
  const scp = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+):([^\s]+)$/.exec(origin);
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : origin);
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
    // An SSH port belongs to the clone endpoint, not the repository's website.
    const web = url.protocol === 'ssh:' ? new URL(`https://${url.hostname}${url.pathname}`) : url;
    web.username = '';
    web.password = '';
    web.search = '';
    web.hash = '';
    web.pathname = web.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (web.pathname === '/') return null;
    return web.href;
  } catch {
    return null;
  }
};
