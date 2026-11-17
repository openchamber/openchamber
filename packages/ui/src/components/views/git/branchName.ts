// external: https://git-scm.com/docs/git-check-ref-format Branch names obey Git's ref restrictions while preserving permitted characters in every script.
export const sanitizeBranchNameInput = (value: string): string => {
  const name = value
    .trim()
    // oxlint-disable-next-line no-control-regex -- git forbids control characters in ref names
    .replace(/[\s\x00-\x1f\x7f~^:?*[\\]+/g, '-')
    .replace(/@\{/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((component) => component.replace(/^[-.]+/, '').replace(/(?:\.lock|-)+$/, ''))
    .filter(Boolean)
    .join('/')
    .replace(/(?:\.lock|\.)+$/, '');
  return name === '@' ? '' : name;
};
