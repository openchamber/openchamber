import { describe, expect, test } from 'bun:test';

import {
  findRepoFile,
  getDirectoryForFilePath,
  getDisambiguatingFolders,
  getRelativeFilePath,
  isAbsoluteFilePath,
  isFilePathWithinDirectory,
  isSameRepoFile,
  normalizeFilePath,
  toAbsoluteFilePath,
} from './path-utils';

describe('path-utils', () => {
  test('a path git lists names a file only when all of the file\'s path under the directory matches', () => {
    // Project in a subfolder: git answers from the repository's top.
    expect(isSameRepoFile('/repo/sub/in-sub.md', '/repo/sub', 'sub/in-sub.md')).toBe(true);
    expect(isSameRepoFile('/repo/sub/in-sub.md', '/repo', 'sub/in-sub.md')).toBe(true);
    // Same name, other folder.
    expect(isSameRepoFile('/proj/vendor/README.md', '/proj', 'README.md')).toBe(false);
    expect(isSameRepoFile('/proj/vendor/docs/a.md', '/proj/vendor', 'a.md')).toBe(false);
    expect(isSameRepoFile('/repo/my-a.md', '/repo', 'a.md')).toBe(false);
    // A file outside the directory, and nothing to compare.
    expect(isSameRepoFile('/repo/top.md', '/repo/sub', 'top.md')).toBe(true);
    expect(isSameRepoFile('/repo/top.md', '/repo/sub', 'other.md')).toBe(false);
    expect(isSameRepoFile('/repo/a.md', '/repo', undefined)).toBe(false);
  });

  test('finds the listing entry of an absolute file, picking the exact one among same names', () => {
    const listing = ['docs/a.md', 'a.md', 'sub/in-sub.md'];
    expect(findRepoFile('/repo/a.md', '/repo', listing)).toBe('a.md');
    expect(findRepoFile('/repo/docs/a.md', '/repo', listing)).toBe('docs/a.md');
    expect(findRepoFile('/repo/sub/in-sub.md', '/repo/sub', listing)).toBe('sub/in-sub.md');
    expect(findRepoFile('/repo/missing.md', '/repo', listing)).toBeUndefined();
    // Project in a subfolder, the same name elsewhere in the repository.
    expect(findRepoFile('/repo/pkg/a.md', '/repo/pkg', ['b/a.md', 'pkg/a.md'])).toBe('pkg/a.md');
    // The listing does not end the file's path, as through a symlink.
    expect(findRepoFile('/link/a.md', '/link', ['z/a.md', 'y/x/a.md'])).toBe('z/a.md');
  });

  test('Windows paths compare in any case, Unix paths do not', () => {
    expect(isSameRepoFile('C:\\Repo\\SRC\\a.ts', 'c:/repo', 'src/a.ts')).toBe(true);
    expect(isSameRepoFile('/repo/SRC/a.ts', '/repo', 'src/a.ts')).toBe(false);
  });

  test('preserves filename whitespace only when requested', () => {
    const options = { preserveWhitespace: true };
    expect(normalizeFilePath('  report.md  ')).toBe('report.md');
    expect(normalizeFilePath('  report.md  ', options)).toBe('  report.md  ');
    expect(toAbsoluteFilePath('/repo', '  report.md  ', options)).toBe('/repo/  report.md  ');
    expect(toAbsoluteFilePath('/repo', '/other/report.md  ', options)).toBe('/other/report.md  ');
    expect(toAbsoluteFilePath('/repo', '  /other.md', options)).toBe('/repo/  /other.md');
    expect(toAbsoluteFilePath('C:/repo', '../report.md  ', options)).toBe('C:/report.md  ');
  });

  test('normalizes Windows paths without losing drive roots', () => {
    expect(normalizeFilePath('C:\\Users\\Bohdan Triapitsyn\\projects\\openchamber\\')).toBe('C:/Users/Bohdan Triapitsyn/projects/openchamber');
    expect(normalizeFilePath('C:/')).toBe('C:/');
    expect(normalizeFilePath('\\\\server\\share\\project')).toBe('//server/share/project');
  });

  test('recognizes Windows absolute paths', () => {
    expect(isAbsoluteFilePath('C:/Users/file.ts')).toBe(true);
    expect(isAbsoluteFilePath('C:\\Users\\file.ts')).toBe(true);
    expect(isAbsoluteFilePath('C:relative/file.ts')).toBe(false);
    expect(isAbsoluteFilePath('src/file.ts')).toBe(false);
  });

  test('strips the leading slash from a bare Windows drive reference', () => {
    // RFC 8089 E.2.1 form: a markdown href like /C:/... reaches the resolver
    // with a leading slash. Windows would read the unslashed path as C:\C:\...
    expect(normalizeFilePath('/C:/Users/test/report.html')).toBe('C:/Users/test/report.html');
    expect(normalizeFilePath('/c:/Users/test/report.html')).toBe('c:/Users/test/report.html');
    expect(isAbsoluteFilePath('/C:/Users/file.ts')).toBe(true);
  });

  test('treats a slashed drive reference as inside its Windows directory', () => {
    expect(isFilePathWithinDirectory('/C:/example/project/package.json', 'C:/example/project')).toBe(true);
  });

  test('does not prefix Windows absolute targets with the workspace directory', () => {
    expect(toAbsoluteFilePath('C:/Users/Bohdan Triapitsyn/projects/openchamber', 'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui/Button.tsx')).toBe(
      'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui/Button.tsx',
    );
  });

  test('joins relative targets under Windows workspaces', () => {
    expect(toAbsoluteFilePath('C:/Users/Bohdan Triapitsyn/projects/openchamber', 'packages/ui/Button.tsx')).toBe(
      'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui/Button.tsx',
    );
    expect(toAbsoluteFilePath('C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui', '../web/package.json')).toBe(
      'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/web/package.json',
    );
  });

  test('compares Windows workspace containment case-insensitively', () => {
    expect(isFilePathWithinDirectory(
      'c:/users/bohdan triapitsyn/projects/openchamber/packages/ui/button.tsx',
      'C:/Users/Bohdan Triapitsyn/projects/openchamber',
    )).toBe(true);
    expect(getRelativeFilePath(
      'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui/Button.tsx',
      'c:/users/bohdan triapitsyn/projects/openchamber',
    )).toBe('packages/ui/Button.tsx');
  });

  test('falls back to file parent when current directory does not contain the path', () => {
    expect(getDirectoryForFilePath(
      'C:/Users/Bohdan Triapitsyn/projects/other',
      'C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui/Button.tsx',
    )).toBe('C:/Users/Bohdan Triapitsyn/projects/openchamber/packages/ui');
    expect(getDirectoryForFilePath('', '/tmp/file.txt')).toBe('/tmp');
  });

  test('names the folders that tell same-named files apart', () => {
    const folders = getDisambiguatingFolders([
      'README.md',
      'docs/README.md',
      'packages/ui/src/index.ts',
      'packages/web/src/index.ts',
      'src/App.tsx',
    ]);
    expect(Object.fromEntries(folders)).toEqual({
      'docs/README.md': 'docs',
      'packages/ui/src/index.ts': 'ui/src',
      'packages/web/src/index.ts': 'web/src',
    });
  });

  test('shows all folders of a path that ends inside another', () => {
    const folders = getDisambiguatingFolders(['a/README.md', 'x/a/README.md']);
    expect(folders.get('a/README.md')).toBe('a');
    expect(folders.get('x/a/README.md')).toBe('x/a');
  });
});
