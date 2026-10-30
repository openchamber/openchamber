import { describe, expect, test } from 'bun:test';

import {
  getDirectoryForFilePath,
  getDisambiguatingFolders,
  getRelativeFilePath,
  isAbsoluteFilePath,
  isFilePathWithinDirectory,
  normalizeFilePath,
  toAbsoluteFilePath,
} from './path-utils';

describe('path-utils', () => {
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
