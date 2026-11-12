import { describe, expect, test } from 'bun:test';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { getSelectedProjectActionId, setSelectedProjectActionId } from './projectActionSelection';

describe('project action selection', () => {
  test('keeps one pick per runtime and project', () => {
    getSafeStorage().clear();
    setSelectedProjectActionId('project-1', 'dev', 'local');
    setSelectedProjectActionId('project-2', 'build', 'local');
    setSelectedProjectActionId('project-1', 'serve', 'remote');
    setSelectedProjectActionId('project-1', 'test', 'local');

    expect(getSelectedProjectActionId('project-1', 'local')).toBe('test');
    expect(getSelectedProjectActionId('project-2', 'local')).toBe('build');
    expect(getSelectedProjectActionId('project-1', 'remote')).toBe('serve');
    expect(getSelectedProjectActionId('project-3', 'local')).toBeNull();
  });

  test('reads unreadable stored data as no pick', () => {
    getSafeStorage().setItem('oc.projectActions.selectedAction.v1', '{"local":["dev"]}');
    expect(getSelectedProjectActionId('project-1', 'local')).toBeNull();
    getSafeStorage().setItem('oc.projectActions.selectedAction.v1', 'not json');
    expect(getSelectedProjectActionId('project-1', 'local')).toBeNull();
  });
});
