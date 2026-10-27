import { afterEach, describe, expect, test } from 'bun:test';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { subscribeSpaceSessionProject } from './space-session-project';

const ID = 'a1b2c3d4e5f6';
const mark = (projectDirectory: string | null): SpaceMark => ({
  id: ID, name: 'quick-falcon', state: 'complete', projectDirectory, directory: projectDirectory ? `/spaces/${ID}/app` : null,
});

const initialProjects = useProjectsStore.getState();
const initialSession = useSessionUIStore.getState();
afterEach(() => {
  useSpacesStore.getState().applyMarks([]);
  useProjectsStore.setState(initialProjects, true);
  useSessionUIStore.setState(initialSession, true);
});

describe('subscribeSpaceSessionProject', () => {
  test('makes the project of the open space session active once the space list names it', () => {
    const activated: string[] = [];
    useProjectsStore.setState({
      projects: [{ id: 'app', path: '/repo/app' }, { id: 'other', path: '/repo/other' }],
      activeProjectId: 'other',
      setActiveProjectIdOnly: (id: string) => { activated.push(id); },
    });
    useSessionUIStore.setState({ currentSessionId: 'ses_space', currentSessionDirectory: `/spaces/${ID}/app` });
    const unsubscribe = subscribeSpaceSessionProject(getRuntimeKey());
    try {
      useSpacesStore.getState().applyMarks([mark(null)]);
      expect(activated).toEqual([]);
      useSpacesStore.getState().applyMarks([mark('/repo/app')]);
      expect(activated).toEqual(['app']);
      // The same list again changes nothing.
      useSpacesStore.getState().applyMarks([mark('/repo/app')]);
      expect(activated).toEqual(['app']);
    } finally {
      unsubscribe();
    }
  });

  test('leaves the active project alone when the open session is on the host', () => {
    const activated: string[] = [];
    useProjectsStore.setState({
      projects: [{ id: 'app', path: '/repo/app' }],
      activeProjectId: null,
      setActiveProjectIdOnly: (id: string) => { activated.push(id); },
    });
    useSessionUIStore.setState({ currentSessionId: 'ses_host', currentSessionDirectory: '/repo/app' });
    const unsubscribe = subscribeSpaceSessionProject(getRuntimeKey());
    try {
      useSpacesStore.getState().applyMarks([mark('/repo/app')]);
      expect(activated).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
