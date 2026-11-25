import { describe, expect, test } from 'bun:test';
import { getAncestorPaths, getDisplayPath, isPathWithinRoot, normalizePath } from './fileViewPaths';

describe('file view paths at a filesystem root', () => {
  test('a file under the unix root is inside it', () => {
    expect(normalizePath('/')).toBe('/');
    expect(isPathWithinRoot('/etc/hosts', '/')).toBe(true);
    expect(isPathWithinRoot('/', '/')).toBe(true);
    expect(isPathWithinRoot('/a', '/')).toBe(true);
  });

  test('a file under a drive root is inside it, whatever the letter case', () => {
    expect(normalizePath('C:/')).toBe('C:/');
    expect(isPathWithinRoot('C:/Users/person/a.ts', 'C:/')).toBe(true);
    expect(isPathWithinRoot('c:/users/person/a.ts', 'C:/')).toBe(true);
    expect(isPathWithinRoot('C:/', 'C:/')).toBe(true);
  });

  test('a sibling with the root as a prefix stays outside it', () => {
    expect(isPathWithinRoot('/repo/a.ts', '/repo')).toBe(true);
    expect(isPathWithinRoot('/repo2/a.ts', '/repo')).toBe(false);
    expect(isPathWithinRoot('C:/Repository/a.ts', 'C:/Repo')).toBe(false);
  });

  test('ancestor paths are built from a root', () => {
    expect(getAncestorPaths('/repo/a/b.ts', '/repo')).toEqual(['/repo/a']);
    expect(getAncestorPaths('/a/b.ts', '/')).toEqual(['/a']);
    expect(getAncestorPaths('C:/Users/person/a.ts', 'C:/')).toEqual(['C:/Users', 'C:/Users/person']);
    expect(getAncestorPaths('/outside/a.ts', '/repo')).toEqual([]);
  });

  test('a display path is relative to the root, including the root itself', () => {
    expect(getDisplayPath('/repo', '/repo/a/b.ts')).toBe('a/b.ts');
    expect(getDisplayPath('/', '/a/b.ts')).toBe('a/b.ts');
    expect(getDisplayPath('C:/', 'C:/Users/person')).toBe('Users/person');
    expect(getDisplayPath('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts');
  });
});
