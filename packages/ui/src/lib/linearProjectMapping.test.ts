import { describe, expect, test } from 'bun:test';
import { linearMappingShowsEmptyTeamsNote, linearMappingTeamsTruncated, resolveLinearMappedProjectPath } from './linearProjectMapping';
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

describe('linearMappingTeamsTruncated', () => {
  test('a mappingGet result carrying teamsMore: true flows to the consumer unchanged', () => {
    const result: LinearMappingResult = { ...mapping(), teamsMore: true };
    expect(result.teamsMore).toBe(true);
    expect(linearMappingTeamsTruncated(result)).toBe(true);
  });

  test('is false when teamsMore is false or absent', () => {
    expect(linearMappingTeamsTruncated({ ...mapping(), teamsMore: false })).toBe(false);
    expect(linearMappingTeamsTruncated(mapping())).toBe(false);
    expect(linearMappingTeamsTruncated(null)).toBe(false);
    expect(linearMappingTeamsTruncated(undefined)).toBe(false);
  });
});

describe('linearMappingShowsEmptyTeamsNote', () => {
  test('is false for an empty list that is truncated, so the page never claims the workspace has no teams', () => {
    const result: LinearMappingResult = { connected: true, teams: [], teamsMore: true };
    expect(linearMappingTeamsTruncated(result)).toBe(true);
    expect(linearMappingShowsEmptyTeamsNote(result)).toBe(false);
  });

  test('is true for an empty list that is complete', () => {
    expect(linearMappingShowsEmptyTeamsNote({ connected: true, teams: [] })).toBe(true);
    expect(linearMappingShowsEmptyTeamsNote({ connected: true, teams: [], teamsMore: false })).toBe(true);
  });

  test('is false when the list has teams', () => {
    expect(linearMappingShowsEmptyTeamsNote(mapping())).toBe(false);
    expect(linearMappingShowsEmptyTeamsNote({ ...mapping(), teamsMore: true })).toBe(false);
  });
});
