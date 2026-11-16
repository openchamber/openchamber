// bun-pty 0.6 imports on older Bun, including early 1.4.0 canaries, but cannot spawn there.
// The server's terminal and the CLI's choice of server runtime both follow this rule.
export function bunVersionRunsBunPty(version) {
  const [major, minor] = (version ?? '').split('.').map(Number);
  return (major > 1 || (major === 1 && minor >= 4)) && !version.startsWith('1.4.0-');
}
