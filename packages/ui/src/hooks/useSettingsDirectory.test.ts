import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import { resolveSettingsDirectory } from './useSettingsDirectory';

const project = (id: string, path: string): ProjectEntry => ({ id, path } as ProjectEntry);

const projects = [
  project('a', '/workspace/alpha'),
  project('b', '/workspace/beta'),
];

describe('resolveSettingsDirectory', () => {
  test('follows the active project until Settings picks one', () => {
    expect(resolveSettingsDirectory(null, projects, 'b')).toBe('/workspace/beta');
  });

  test('keeps the Settings pick even when the app is on another project', () => {
    // The whole point: browsing another project's configuration must not depend
    // on moving the app to it.
    expect(resolveSettingsDirectory('/workspace/alpha', projects, 'b')).toBe('/workspace/alpha');
  });

  test('falls back to the active project when the picked one is gone', () => {
    expect(resolveSettingsDirectory('/workspace/removed', projects, 'b')).toBe('/workspace/beta');
  });

  test('resolves to nothing when there are no projects', () => {
    expect(resolveSettingsDirectory('/workspace/alpha', [], null)).toBe(null);
  });
});
