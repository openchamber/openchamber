import { afterEach, describe, expect, test } from 'bun:test';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessions/sessionOwnership';
import { buildKnownSessionDirectories } from '@/components/session/sidebar/list/sessionListDirectories';
import { findIntegrateCheckout, publishIntegrateCheckouts } from './worktrees/integrateCheckouts';
import { resolveProjectForSessionDirectory } from './projectResolution';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useSpacesStore } from './spaces/spaces-store';

const projects = [
  { id: 'openchamber', path: '/workspace/openchamber', label: 'OpenChamber' },
];

describe('resolveProjectForSessionDirectory', () => {
  test('resolves descendants of Unix and Windows drive root projects', () => {
    const roots = [{ id: 'unix', path: '/' }, { id: 'drive', path: 'C:/' }];
    expect(resolveProjectForSessionDirectory(roots, new Map(), '/workspace/project')?.id).toBe('unix');
    expect(resolveProjectForSessionDirectory(roots, new Map(), 'c:\\Users\\Developer\\Project')?.id).toBe('drive');
    expect(resolveProjectForSessionDirectory(roots, new Map(), 'D:/Project')).toBeNull();
  });

  test('resolves a sibling worktree to its registered project', () => {
    const worktrees = new Map([
      ['/workspace/openchamber', [{
        path: '/workspace/openchamber-feature',
        projectDirectory: '/workspace/openchamber',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory(projects, worktrees, '/workspace/openchamber-feature')).toEqual(projects[0]);
  });

  test('prefers registered worktree ownership over a containing project', () => {
    const configuredProjects = [
      { id: 'home', path: '/Users/elfy', label: 'Home' },
      { id: 'infoscan', path: '/Users/elfy/GitRepos/infoscan', label: 'InfoScan' },
    ];
    const worktreePath = '/Users/elfy/.local/share/opencode/worktree/refactor-self-hosted-runners';
    const worktrees = new Map([
      ['/Users/elfy/GitRepos/infoscan', [{
        path: worktreePath,
        projectDirectory: '/Users/elfy/GitRepos/infoscan',
        branch: 'refactor/self-hosted-runners',
        label: 'refactor/self-hosted-runners',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory(configuredProjects, worktrees, worktreePath)).toEqual(configuredProjects[1]);
  });

  test('resolves a session in an isolated space to the project the space was made from', () => {
    const space = '0123456789ab';
    const initial = useSpacesStore.getState();
    try {
      // Unknown space: no project, rather than a guess from the path.
      expect(resolveProjectForSessionDirectory(projects, new Map(), `/spaces/${space}/openchamber/src`)).toBeNull();
      useSpacesStore.setState({ spaces: new Map([[space, { id: space, name: 'quick-falcon', state: 'complete', projectDirectory: '/workspace/openchamber', directory: `/spaces/${space}/openchamber` }]]) });
      expect(resolveProjectForSessionDirectory(projects, new Map(), `/spaces/${space}/openchamber/src`)).toEqual(projects[0]);
    } finally {
      useSpacesStore.setState(initial, true);
    }
  });
});

describe('a checkout integration opened', () => {
  const home = { id: 'home', path: '/Users/elfy' };
  const app = { id: 'app', path: '/Users/elfy/app' };
  const checkout = '/Users/elfy/.config/openchamber/tmp/oc-integrate-x';

  afterEach(() => {
    for (const projectPath of [app.path, '/Users/elfy/app/packages/ui']) publishIntegrateCheckouts(projectPath, app.path, []);
  });

  test('is remembered for the next load of this server only', () => {
    publishIntegrateCheckouts(app.path, app.path, [checkout]);
    const stored = JSON.parse(getSafeStorage().getItem('oc.integrateCheckouts.v1') ?? '{}');
    expect(Object.values(stored)).toEqual([{ [app.path]: { repositoryRoot: app.path, paths: [checkout] } }]);
    expect(findIntegrateCheckout(`${checkout}/src`)?.path).toBe(checkout);
    publishIntegrateCheckouts(app.path, app.path, []);
    expect(getSafeStorage().getItem('oc.integrateCheckouts.v1')).toBe('{}');
  });

  test('belongs to its repository\'s project and is not a listed worktree', () => {
    publishIntegrateCheckouts(app.path, app.path, [checkout]);

    expect(resolveProjectForSessionDirectory([home, app], new Map(), `${checkout}/src`)).toEqual(app);
    expect(buildKnownSessionDirectories([home, app], new Map()).has(checkout)).toBe(true);
    const ownership = createSessionOwnershipIndex(
      [{ id: 'resolver', directory: checkout, projectID: 'x', title: '', time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
      [home, app].map(({ id, path }) => ({ id, normalizedPath: path })), new Map(), false,
    );
    expect(ownership.bySessionId.get('resolver')).toMatchObject({ projectId: 'app', scopeDirectory: app.path, kind: 'project' });

    publishIntegrateCheckouts(app.path, app.path, []);
    expect(resolveProjectForSessionDirectory([home, app], new Map(), checkout)).toEqual(home);
  });

  test('is forgotten for every project of the repository once one listing leaves it out', () => {
    publishIntegrateCheckouts('/Users/elfy/app/packages/ui', app.path, [checkout]);
    publishIntegrateCheckouts(app.path, app.path, [checkout]);
    publishIntegrateCheckouts(app.path, app.path, []);
    expect(findIntegrateCheckout(checkout)).toBeNull();
  });

  test('keeps what another window stored for another project', () => {
    publishIntegrateCheckouts(app.path, app.path, [checkout]);
    const key = 'oc.integrateCheckouts.v1';
    const stored = JSON.parse(getSafeStorage().getItem(key) ?? '{}');
    const other = { repositoryRoot: '/Users/elfy/other', paths: ['/tmp/oc-integrate-y'] };
    for (const runtime of Object.keys(stored)) stored[runtime]['/Users/elfy/other'] = other;
    getSafeStorage().setItem(key, JSON.stringify(stored));
    publishIntegrateCheckouts(app.path, app.path, []);
    expect(Object.values(JSON.parse(getSafeStorage().getItem(key) ?? '{}'))).toEqual([{ '/Users/elfy/other': other }]);
    getSafeStorage().removeItem(key);
  });

  test('belongs to a project opened on a folder of the repository', () => {
    const folder = { id: 'folder', path: '/Users/elfy/app/packages/ui' };
    publishIntegrateCheckouts(folder.path, app.path, [checkout]);
    expect(resolveProjectForSessionDirectory([folder], new Map(), checkout)).toEqual(folder);
  });
});
