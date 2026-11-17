export function bunVersionRunsBunPty(version) {
  const [major, minor] = (version ?? '').split('.').map(Number);
  return (major > 1 || (major === 1 && minor >= 4)) && !version.startsWith('1.4.0-');
}
