/**
 * The name a plugin card shows for a config entry. The spec itself stays the
 * card's second line: a local path is one long unbreakable word whose start
 * (`/Users/…`) says nothing, and a package spec carries a version range.
 *
 * - A path (absolute, `./`, `../`, `file://`) shows its last segment; an
 *   entry file named `index.*` shows the folder that holds it.
 * - A Git spec (`github:owner/repo`, `git+https://…/repo.git#tag`) shows the
 *   repository name.
 * - An npm spec shows the package name without its version or tag.
 */
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

  // `@scope/name@1.2.3` keeps its leading `@`; the version starts at the next one.
  const versionAt = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
  return versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed;
}
