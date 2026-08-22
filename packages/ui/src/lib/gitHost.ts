/**
 * Parse a git remote or custom-domain string and return its bare hostname.
 *
 * Understands URL forms with any scheme (`https://`, `ssh://`, `git+ssh://`,
 * `git://`, ...), scp-like forms with or without a `user@` prefix
 * (`git@host:owner/repo.git`, `host:owner/repo.git`), and IPv6 addresses
 * (bracketed or unbracketed). The result is normalized: lowercase, no
 * surrounding IPv6 brackets, no scheme, port, or path, and at most one
 * trailing dot stripped. Returns `null` for empty, whitespace, or unparseable
 * input.
 */
export const parseGitHost = (raw: string): string | null => {
  const value = (raw ?? '').trim();
  if (!value) {
    return null;
  }

  // scp-like form: [user@]host:path — never applies once a scheme is present.
  if (!value.includes('://')) {
    const authority = value.slice(value.lastIndexOf('@') + 1);
    // Bracketed IPv6, e.g. `[2001:db8::1]` or `[2001:db8::1]:owner/repo.git`.
    if (authority.startsWith('[')) {
      const close = authority.indexOf(']');
      if (close > 0 && authority.slice(1, close).includes(':')) {
        return normalizeHost(authority.slice(1, close));
      }
      // Malformed brackets fall through to URL parsing, which rejects them.
    } else {
      const colon = authority.indexOf(':');
      if (colon > 0) {
        const candidate = authority.slice(0, colon);
        // A single-segment pre-colon value without a dot is not a host — the
        // guard rejects Windows paths like `C:\foo`, which then fall through
        // to URL parsing and fail on the non-numeric port. Hosts with a
        // numeric port (`localhost:3000`) still resolve via the URL branch.
        if (!candidate.includes('/') && candidate.includes('.')) {
          return normalizeHost(candidate);
        }
      }
      // Unbracketed IPv6 (e.g. `2001:db8::1`): parse it as a bracketed host
      // so the address survives instead of tripping over the scp colon split.
      if (authority.includes(':') && !authority.includes('/') && authority.length > 2) {
        try {
          return normalizeHost(new URL(`ssh://[${authority}]`).hostname);
        } catch {
          // Not an IPv6 address; fall through to generic URL parsing.
        }
      }
    }
    // No colon or a non-host pre-colon segment: fall through to URL parsing.
  }

  try {
    const parsed = new URL(value.includes('://') ? value : `ssh://${value}`);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
};

const normalizeHost = (host: string): string =>
  host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
