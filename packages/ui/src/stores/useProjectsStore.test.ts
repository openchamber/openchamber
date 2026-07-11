import { beforeEach, describe, expect, test } from 'bun:test';
import { useProjectsStore } from './useProjectsStore';

describe('useProjectsStore moveProjectToTop', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [
        { id: 'alpha', path: '/workspace/alpha', label: 'Alpha' },
        { id: 'beta', path: '/workspace/beta', label: 'Beta' },
        { id: 'gamma', path: '/workspace/gamma', label: 'Gamma' },
      ],
      activeProjectId: 'beta',
    });
  });

  test('promotes only the conversation project while preserving the remaining order', () => {
    useProjectsStore.getState().moveProjectToTop('gamma');

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
    expect(useProjectsStore.getState().activeProjectId).toBe('beta');
  });

  test('does not replace the project list when the project is already first or missing', () => {
    const initial = useProjectsStore.getState().projects;

    useProjectsStore.getState().moveProjectToTop('alpha');
    expect(useProjectsStore.getState().projects).toBe(initial);

    useProjectsStore.getState().moveProjectToTop('missing');
    expect(useProjectsStore.getState().projects).toBe(initial);
  });
});
