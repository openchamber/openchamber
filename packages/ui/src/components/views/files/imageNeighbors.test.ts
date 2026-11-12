import { describe, expect, test } from 'bun:test';

import { imageNeighborsOf } from './imageNeighbors';

const entry = (name: string, type: 'file' | 'directory' = 'file') => ({ name, path: `/repo/shots/${name}`, type });

const FOLDER = [
  entry('nested', 'directory'),
  entry('a.png'),
  entry('notes.md'),
  entry('b.jpg'),
  entry('c.webp'),
  entry('icon.svg'),
];

const names = (result: { previous: { name: string }; next: { name: string } } | null) => (
  result ? [result.previous.name, result.next.name] : null
);

describe('imageNeighborsOf', () => {
  test('steps over folders and files that are not images', () => {
    expect(names(imageNeighborsOf(FOLDER, '/repo/shots/b.jpg'))).toEqual(['a.png', 'c.webp']);
  });

  test('wraps around at both ends', () => {
    expect(names(imageNeighborsOf(FOLDER, '/repo/shots/a.png'))).toEqual(['icon.svg', 'b.jpg']);
    expect(names(imageNeighborsOf(FOLDER, '/repo/shots/icon.svg'))).toEqual(['c.webp', 'a.png']);
  });

  test('has nothing to offer for a lone image or a path outside the listing', () => {
    expect(imageNeighborsOf([entry('a.png'), entry('notes.md')], '/repo/shots/a.png')).toBeNull();
    expect(imageNeighborsOf(FOLDER, '/repo/shots/gone.png')).toBeNull();
  });
});
