type ExtensionInstallLink = { kind: 'url' | 'path'; source: string };

const LINK_PREFIX = 'openchamber://extensions/install?';

export const parseExtensionInstallLink = (href: string): ExtensionInstallLink | null => {
  if (!href.toLowerCase().startsWith(LINK_PREFIX)) return null;
  const params = new URLSearchParams(href.slice(LINK_PREFIX.length));
  const path = params.get('path');
  if (path) return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) ? { kind: 'path', source: path } : null;
  const url = params.get('url');
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? { kind: 'url', source: url } : null;
  } catch {
    return null;
  }
};
