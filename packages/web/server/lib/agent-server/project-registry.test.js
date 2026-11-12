import { describe, expect, it, vi } from 'vitest';
import { createProjectRegistry, normalizeRegistryProjectPath, sanitizeRegistryProjects } from './project-registry.js';

const project = (directory, extra = {}) => ({ id: directory, path: directory, ...extra });

describe('front-door project registry', () => {
  it.each(['', '/', '.', '../work', '~/work', '/work/../secret', '/work/./repo', '//work/repo', '/work//repo',
    '/work/repo/', '/work\u0000repo', '/work\nrepo', '/work\\repo', ' /work/repo', '/work/repo '])(
    'refuses unsafe or ambiguous paths before invoking authority: %j', async (directory) => {
      const ownsProject = vi.fn(() => true);
      const shareProject = vi.fn();
      await expect(createProjectRegistry({ ownsProject, shareProject }).authorizeProject(directory))
        .rejects.toMatchObject({ code: 'project_path_invalid' });
      expect(ownsProject).not.toHaveBeenCalled();
      expect(shareProject).not.toHaveBeenCalled();
    },
  );

  it.each(['/spaces', '/spaces/abc/repo', '/var/lib/openchamber-spaces/a', '/var/lib/private/openchamber-spaces/a',
    '/var/lib/openchamber-hostd/spaces/a'])('refuses space roots even when ownership would be claimed: %s', async (directory) => {
    const ownsProject = vi.fn(() => true);
    await expect(createProjectRegistry({ ownsProject }).authorizeProject(directory))
      .rejects.toMatchObject({ code: 'space_project_refused' });
    expect(ownsProject).not.toHaveBeenCalled();
  });

  it('defaults to refusing unshared projects', async () => {
    await expect(createProjectRegistry().authorizeProject('/home/agent/repo'))
      .rejects.toMatchObject({ code: 'share_project_unavailable' });
  });

  it('accepts ownership only from the injected predicate with literal true', async () => {
    const shareProject = vi.fn(async () => {});
    const registry = createProjectRegistry({ ownsProject: async (directory) => directory === '/owned', shareProject });
    await expect(registry.authorizeProject('/owned')).resolves.toBe('/owned');
    expect(shareProject).not.toHaveBeenCalled();
    await registry.beforeProjectsSave([project('/human', { ownedByAgent: true, owner: 'agent' })], []);
    expect(shareProject).toHaveBeenCalledWith('/human');
    await createProjectRegistry({ ownsProject: async () => ({ owned: true }), shareProject }).authorizeProject('/untrusted');
    expect(shareProject).toHaveBeenLastCalledWith('/untrusted');
  });

  it('shares only newly introduced paths, including a changed path with the same id', async () => {
    const shareProject = vi.fn(async () => {});
    const { beforeProjectsSave } = createProjectRegistry({ shareProject });
    const current = [project('/kept'), project('/removed')];
    await beforeProjectsSave([project('/kept', { label: 'Renamed' })], current);
    expect(shareProject).not.toHaveBeenCalled();
    await beforeProjectsSave([project('/kept'), project('/changed', { id: '/removed' })], current);
    expect(shareProject.mock.calls).toEqual([['/changed']]);
    await beforeProjectsSave([], current);
    expect(shareProject).toHaveBeenCalledTimes(1);
  });

  it('propagates sharing refusal without proceeding to later shares', async () => {
    const shareProject = vi.fn(async () => { throw Object.assign(new Error('refused'), { code: 'project_not_shareable' }); });
    await expect(createProjectRegistry({ shareProject }).beforeProjectsSave([project('/first'), project('/second')], []))
      .rejects.toMatchObject({ code: 'project_not_shareable' });
    expect(shareProject.mock.calls).toEqual([['/first']]);
  });

  it('projects only the known record shape and never consults the filesystem', () => {
    expect(normalizeRegistryProjectPath('/nonexistent/project name')).toBe('/nonexistent/project name');
    expect(sanitizeRegistryProjects([project('/nonexistent/project name', {
      environment: { SECRET: 'bait' }, label: ' Project ', labelSource: 'manual',
    })])).toEqual([project('/nonexistent/project name', { label: 'Project', labelSource: 'manual' })]);
    expect(() => sanitizeRegistryProjects([{}])).toThrow('project_registry_invalid');
  });

  it('refuses duplicates before sanitizing so low-level writers cannot hide an unshared path', async () => {
    const ownsProject = vi.fn(() => true);
    const registry = createProjectRegistry({ ownsProject });
    await expect(registry.beforeProjectsSave([project('/owned', { id: 'same' }), project('/unshared', { id: 'same' })]))
      .rejects.toMatchObject({ code: 'project_registry_invalid' });
    await expect(registry.beforeProjectsSave([project('/owned', { id: 'a' }), project('/owned', { id: 'b' })]))
      .rejects.toMatchObject({ code: 'project_registry_invalid' });
    expect(ownsProject).not.toHaveBeenCalled();
  });
});
