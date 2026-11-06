// `openchamber://extensions/install?url=…` installs from a repository, and
// `?path=…` from a folder. A link can come from any page outside the app, so
// the desktop shell passes on only `url`, and only chat content inside the app
// may carry `path`.
//
// Pure on purpose: the markdown sanitizer, which may run in a worker, uses it.

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
