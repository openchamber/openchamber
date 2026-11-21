import { expect, test } from 'bun:test';
import { getRelativePathLabel } from './contextPanelPaths';

test('file paths are relative to the project, including roots and Windows paths', () => {
  expect(getRelativePathLabel('/etc/hosts', '/')).toBe('etc/hosts');
  expect(getRelativePathLabel('C:\\Repo\\src\\a.ts', 'c:\\repo')).toBe('src/a.ts');
  expect(getRelativePathLabel('C:\\Repo2\\a.ts', 'c:\\repo')).toBe('C:/Repo2/a.ts');
  expect(getRelativePathLabel('/repo/a.ts', '/Repo')).toBe('/repo/a.ts');
  expect(getRelativePathLabel('//server/share/a.ts', '//SERVER/share')).toBe('a.ts');
});
