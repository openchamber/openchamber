
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export function parseGitRemoteListing(listing: string): GitRemote[] {
  const urls = new Map<string, { fetch?: string; push?: string }>();
  for (const line of listing.split(/\r?\n/)) {
    const match = line.match(/^([^\t]+)\t(.*) \((fetch|push)\)/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const entry: { fetch?: string; push?: string } = urls.get(name) ?? {};
    if (kind === 'fetch') {
      entry.fetch ??= url;
    } else {
      entry.push ??= url;
    }
    urls.set(name, entry);
  }
  return Array.from(urls.entries()).map(([name, entry]) => {
    const fetchUrl = entry.fetch ?? name;
    return { name, fetchUrl, pushUrl: entry.push ?? fetchUrl };
  });
}
