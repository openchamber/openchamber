export function bunVersionRunsBunPty(version: string | null | undefined) {
  const [major = Number.NaN, minor = Number.NaN] = (version ?? '').split('.').map(Number);
  return (major > 1 || (major === 1 && minor >= 4)) && !version?.startsWith('1.4.0-');
}
