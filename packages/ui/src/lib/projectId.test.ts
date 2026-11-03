import { describe, expect, test } from 'bun:test';
import { createProjectIdFromPath, projectPathFromId } from './projectId';

describe('projectPathFromId', () => {
  test('round-trips the paths the UI encodes', () => {
    for (const path of ['/home/ubuntu/personal/test', '/Users/me/Projects/café', 'C:/Users/me/repo']) {
      expect(projectPathFromId(createProjectIdFromPath(path))).toBe(path);
    }
  });

  test('reads the id that names a project whose folder path has accents', () => {
    expect(projectPathFromId('path_L2hvbWUvdWJ1bnR1L3Byb2plY3RzL2TDqW1pbmFnZQ')).toBe('/home/ubuntu/projects/déminage');
  });

  test('round-trips a long, unpadded id', () => {
    const path = `/tmp/${'a'.repeat(401)}`;
    const id = createProjectIdFromPath(path);
    expect(id.endsWith('=')).toBe(false);
    expect(projectPathFromId(id)).toBe(path);
  });

  test('returns an empty string for ids that do not name a checkout path', () => {
    expect(projectPathFromId('project-test')).toBe('');
    expect(projectPathFromId('path_')).toBe('');
    expect(projectPathFromId('path_!bad')).toBe('');
    expect(projectPathFromId('path_AAAAA')).toBe('');
  });
});
