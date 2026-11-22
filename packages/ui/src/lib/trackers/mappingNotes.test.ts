import { describe, expect, test } from 'bun:test';
import { trackerMappingContainersTruncated, trackerMappingShowsEmptyContainersNote } from './mappingNotes';

// Ported from the fork's linearProjectMapping.test.ts: the mapping page must
// not present a truncated team list as complete, nor an empty truncated list
// as a workspace with no teams.
const mapping = () => ({ containers: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', projectPath: null }] });

describe('trackerMappingContainersTruncated', () => {
  test('is true when the tracker reports more containers than it read', () => {
    expect(trackerMappingContainersTruncated({ ...mapping(), containersMore: true })).toBe(true);
  });

  test('is false when containersMore is false or absent', () => {
    expect(trackerMappingContainersTruncated({ ...mapping(), containersMore: false })).toBe(false);
    expect(trackerMappingContainersTruncated(mapping())).toBe(false);
    expect(trackerMappingContainersTruncated(null)).toBe(false);
    expect(trackerMappingContainersTruncated(undefined)).toBe(false);
  });
});

describe('trackerMappingShowsEmptyContainersNote', () => {
  test('is false for an empty list that is truncated, so the page never claims the workspace has no teams', () => {
    expect(trackerMappingShowsEmptyContainersNote({ containers: [], containersMore: true })).toBe(false);
  });

  test('is true for an empty list that is complete', () => {
    expect(trackerMappingShowsEmptyContainersNote({ containers: [] })).toBe(true);
    expect(trackerMappingShowsEmptyContainersNote({ containers: [], containersMore: false })).toBe(true);
  });

  test('is false when the list has containers', () => {
    expect(trackerMappingShowsEmptyContainersNote(mapping())).toBe(false);
    expect(trackerMappingShowsEmptyContainersNote({ ...mapping(), containersMore: true })).toBe(false);
  });
});
