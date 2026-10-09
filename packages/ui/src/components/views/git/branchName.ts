/**
 * Turns typed text into a name `git check-ref-format --branch` accepts.
 * Whitespace and the characters git forbids become `-`; the sequences git
 * refuses (`..`, `@{`, a component starting with `.` or ending in `.lock`,
 * a trailing `.`, a lone `@`) are dropped. Every other character stays, so
 * names in any script, such as `feature/测试`, reach git unchanged.
 */
export const sanitizeBranchNameInput = (value: string): string => {
  const name = value
    .trim()
    // eslint-disable-next-line no-control-regex -- git forbids control characters in ref names
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
