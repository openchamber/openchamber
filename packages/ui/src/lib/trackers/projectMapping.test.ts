import { describe, expect, test } from 'bun:test';
import { resolveTrackerMappedProjectPath, trackerProjectContainers } from './projectMapping';
import type { TrackerMappingResult } from './types';

const mapping = (): TrackerMappingResult => ({
  connected: true,
  defaultProjectPath: '/default',
  containers: [
    { id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/eng' },
    { id: 'team-des', key: 'DES', name: 'Design', projectPath: null },
  ],
});

describe('resolveTrackerMappedProjectPath', () => {
  test('prefers the container path over the default', () => {
    expect(resolveTrackerMappedProjectPath(mapping(), { id: 'team-eng', key: 'ENG', name: 'Engineering' }))
      .toBe('/eng');
  });

  test('falls back to the default when the container has no path', () => {
    expect(resolveTrackerMappedProjectPath(mapping(), { id: 'team-des', key: 'DES', name: 'Design' }))
      .toBe('/default');
  });

  test('matches a container by key when the id is missing', () => {
    expect(resolveTrackerMappedProjectPath(mapping(), { id: '', key: 'ENG', name: 'Engineering' }))
      .toBe('/eng');
  });

  test('returns null when the tracker is disconnected or unmapped', () => {
    expect(resolveTrackerMappedProjectPath({ connected: false }, { id: 'team-eng', key: 'ENG', name: 'Engineering' }))
      .toBeNull();
    expect(resolveTrackerMappedProjectPath({
      connected: true,
      defaultProjectPath: null,
      containers: [{ id: 'team-des', key: 'DES', name: 'Design', projectPath: null }],
    }, { id: 'team-des', key: 'DES', name: 'Design' })).toBeNull();
  });

  test('does not map a board or sprint container', () => {
    expect(resolveTrackerMappedProjectPath({
      connected: true,
      defaultProjectPath: '/default',
      containers: [{ id: 'board-1', key: null, name: 'Board', kind: 'board', projectPath: '/board' }],
    }, { id: 'board-1', key: null, name: 'Board', kind: 'board' })).toBe('/default');
  });
});

describe('trackerProjectContainers', () => {
  test('keeps projects, including containers that do not declare a kind', () => {
    expect(trackerProjectContainers([
      { id: 'general', key: null, name: 'General' },
      { id: 'p-1', key: 'PROJ', name: 'Project', kind: 'project' },
      { id: 'b-1', key: null, name: 'Board', kind: 'board' },
      { id: 's-1', key: null, name: 'Sprint', kind: 'sprint' },
    ]).map((container) => container.id)).toEqual(['general', 'p-1']);
  });
});
