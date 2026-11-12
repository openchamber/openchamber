const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Same server: scheme and port match, and the hosts are equal or both loopback. */
export function isSameOpenCodeServer(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (a.protocol !== b.protocol || a.port !== b.port) return false;
    return a.hostname === b.hostname || (LOOPBACK_HOSTS.has(a.hostname) && LOOPBACK_HOSTS.has(b.hostname));
  } catch {
    return false;
  }
}
