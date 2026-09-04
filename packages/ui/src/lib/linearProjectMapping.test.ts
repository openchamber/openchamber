import { describe, expect, test } from 'bun:test';
import { resolveLinearMappedProjectPath } from './linearProjectMapping';
import type { LinearMappingResult } from './api/types';

const mapping = (): LinearMappingResult => ({
  connected: true,
  defaultProjectPath: '/default',
  teams: [
    { id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: '/eng' },
    { id: 'team-des', key: 'DES', name: 'Design', projectPath: null },
  ],
});

describe('resolveLinearMappedProjectPath', () => {
  test('prefers the team path over the default', () => {
    expect(resolveLinearMappedProjectPath(mapping(), { id: 'team-eng', key: 'ENG', name: 'Engineering' }))
      .toBe('/eng');
  });

  test('falls back to the default when the team has no path', () => {
    expect(resolveLinearMappedProjectPath(mapping(), { id: 'team-des', key: 'DES', name: 'Design' }))
      .toBe('/default');
  });

  test('matches a team by key when the id is missing', () => {
    expect(resolveLinearMappedProjectPath(mapping(), { id: '', key: 'ENG', name: 'Engineering' }))
      .toBe('/eng');
  });

  test('returns null when Linear is disconnected or unmapped', () => {
    expect(resolveLinearMappedProjectPath({ connected: false }, { id: 'team-eng', key: 'ENG', name: 'Engineering' }))
      .toBeNull();
    expect(resolveLinearMappedProjectPath({
      connected: true,
      defaultProjectPath: null,
      teams: [{ id: 'team-des', key: 'DES', name: 'Design', projectPath: null }],
    }, { id: 'team-des', key: 'DES', name: 'Design' })).toBeNull();
  });
});
