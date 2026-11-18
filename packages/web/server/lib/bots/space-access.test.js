import { expect, it } from 'vitest';
import { resolveBotSpaceOptions } from './isolated-stages.js';

const project = { id: 'p', path: '/host/project' };
const selection = { providerID: 'selected', modelID: 'model' };
const host = ({ providers = [], logins = [], spaces = [] } = {}) => ({ journey: {
  readHostCustomProviders: async (directory) => { expect(directory).toBe(project.path); return { providers }; },
  readHostLogins: async () => ({ logins }), listSpaces: async () => spaces,
} });
const approved = (name = 'USER_APPROVED_MODEL_KEY', path = project.path) => ({ projectDirectory: path, state: 'running', access: 'granted', grants: [
  { kind: 'model', provider: 'selected', upstream: 'https://models.example.test/v1', source: { kind: 'env', name } },
] });

it('grants only the selected stage provider from existing custom configuration or usable login', async () => {
  expect(await resolveBotSpaceOptions({ host: host({ providers: [{ id: 'selected', supported: true, models: ['model'] }, { id: 'other', supported: true, models: ['other'] }] }), project, selection }))
    .toEqual({ grants: [{ kind: 'custom', provider: 'selected' }] });
  expect(await resolveBotSpaceOptions({ host: host({ logins: [{ provider: 'other', state: 'usable' }, { provider: 'selected', state: 'usable' }] }), project, selection }))
    .toEqual({ grants: [{ kind: 'login', provider: 'selected' }] });
  await expect(resolveBotSpaceOptions({ host: host({ providers: [{ id: 'selected', supported: true, models: ['different'] }] }), project, selection })).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_UNAVAILABLE' });
});

it('reuses only an unambiguous approved source for that provider in the same project', async () => {
  expect(await resolveBotSpaceOptions({ host: host({ spaces: [approved()] }), project, selection })).toEqual({ grants: [{ kind: 'model', provider: 'selected', upstream: 'https://models.example.test/v1', secret: { kind: 'env', name: 'USER_APPROVED_MODEL_KEY' } }] });
  await expect(resolveBotSpaceOptions({ host: host({ spaces: [approved('ONE'), approved('TWO')] }), project, selection })).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_GRANT_AMBIGUOUS' });
  await expect(resolveBotSpaceOptions({ host: host({ spaces: [approved('OTHER_PROJECT', '/other/project')] }), project, selection })).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_GRANT_REQUIRED' });
});

it('does not invent an environment reference for a built-in key or start a host fallback', async () => {
  await expect(resolveBotSpaceOptions({ host: host({ logins: [{ provider: 'selected', state: 'expired' }] }), project, selection })).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_GRANT_REQUIRED', state: 'needs-you' });
  await expect(resolveBotSpaceOptions({ host: null, project, selection })).rejects.toMatchObject({ code: 'BOT_ISOLATION_UNAVAILABLE' });
});
