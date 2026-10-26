import { describe, expect, test } from 'bun:test';

import { fileRowMatchRanges, projectRowMatchRanges } from './commandPaletteMatches';

describe('fileRowMatchRanges', () => {
  test('splits path matches between the name and the folder', () => {
    // "src/ui/Button.tsx": a run across the slash marks both parts.
    expect(fileRowMatchRanges('src/ui/Button.tsx', [[4, 9]])).toEqual({
      name: 'Button.tsx',
      directory: 'src/ui',
      nameRanges: [[0, 2]],
      directoryRanges: [[4, 6]],
    });
  });

  test('a file at the root has no folder', () => {
    expect(fileRowMatchRanges('README.md', [[0, 6]])).toEqual({
      name: 'README.md',
      directory: '',
      nameRanges: [[0, 6]],
      directoryRanges: [],
    });
  });
});

describe('projectRowMatchRanges', () => {
  test('a labelled project marks the label and the path separately', () => {
    // Matched text: "Chamber /home/me/openchamber"
    const project = { label: 'Chamber', path: '/home/me/openchamber', displayName: 'Chamber' };
    expect(projectRowMatchRanges(project, [[0, 4]])).toEqual({ nameRanges: [[0, 4]], pathRanges: [] });
    expect(projectRowMatchRanges(project, [[17, 21]])).toEqual({ nameRanges: [], pathRanges: [[9, 13]] });
  });

  test('without a label the name takes the matches in the last path segment', () => {
    // Matched text: " /home/me/openchamber"; "open" sits at 10.
    const project = { path: '/home/me/openchamber', displayName: 'openchamber' };
    expect(projectRowMatchRanges(project, [[10, 14]])).toEqual({ nameRanges: [[0, 4]], pathRanges: [[9, 13]] });
  });
});
