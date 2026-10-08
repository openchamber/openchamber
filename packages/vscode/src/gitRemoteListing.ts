/**
 * Remote names and URLs from `git remote -v` output.
 *
 * The parser is pure so it can be tested outside the extension host, like the
 * status-path and submodule helpers in `gitPathDiff.ts`. Each remote's URLs
 * must read as `git remote get-url [--push]` reports them, so the line
 * grammar and fallbacks match the web server's `parseRemoteListing`: the
 * first URL of several wins, and a remote with no fetch URL reads as a URL
 * equal to its name, as Git does. Anything after the URL-kind marker — Git
 * 2.54+ appends the partial-clone filter there as `[blob:none]` — is
 * decoration about the remote, never part of the URL, and is ignored whether
 * or not its shape is recognized. Lines may end in CRLF (Git for Windows); a
 * kept `\r` would match no line and read every remote as URL-less. A remote
 * no line parses for is skipped; the web parser keeps it through its
 * separately read remote names.
 */

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
