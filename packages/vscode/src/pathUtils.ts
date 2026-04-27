/**
 * Normalize Windows drive letter to uppercase.
 *
 * VS Code's `workspaceFolders[0].uri.fsPath` returns lowercase drive letters (e.g. `d:\...`),
 * while process.cwd() (used by OpenCode server) returns uppercase (e.g. `D:\...`).
 * Normalize to uppercase so session directory queries match.
 */
export const normalizeWindowsDriveLetter = (p: string): string =>
  p.replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
