export function pluginDisplayName(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return spec;

  const isPath = trimmed.startsWith('file://')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (isPath) {
    const segments = trimmed.replace(/^file:\/\//, '').split(/[\\/]+/).filter((segment) => segment && segment !== '.' && segment !== '..');
    const last = segments.at(-1);
    if (!last) return trimmed;
    if (/^index\.[cm]?[jt]sx?$/.test(last) && segments.length > 1) return segments.at(-2) ?? last;
    return last;
  }

  if (trimmed.startsWith('github:') || trimmed.startsWith('git+') || trimmed.includes('://')) {
    const withoutRef = trimmed.replace(/#.*$/, '').replace(/\/+$/, '');
    const repository = withoutRef.split(/[/:]/).at(-1)?.replace(/\.git$/, '');
    return repository || trimmed;
  }

  const versionAt = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
  return versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed;
}
