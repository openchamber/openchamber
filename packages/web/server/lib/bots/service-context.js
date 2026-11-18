/** Wiring: createBotServiceContext({ identities, services, fetchImpl?, policyOptions? })
 * returns { serviceContext, github, repository, author }. Optional
 * resolveDiscordTarget({ project, bot, item }) must resolve a server-owned
 * captured channel/recipient; selecting Discord without it refuses explicitly.
 * serviceContext requires service and operation and resolves only that service.
 * Pass serviceContext to createBotsRuntime; pass this object as context to both
 * production adapters. Credentials returned by github are server-private.
 */
import { z } from 'zod';
import { resolvePrivateRepositoryIdentity } from '../source-control/repository-identity.js';
import { parseGitHubRemoteUrl } from '../github/repo/index.js';
import { createCredentialResolver } from './services/credentials.js';
import { createJiraOAuthHttp, createProviderHttp } from './services/http.js';
import { BotServiceError, discordTarget, githubTarget, jiraTarget, operations, providerResult, text } from './services/contracts.js';

const refuse = (code) => { throw new BotServiceError(code, 'Repair the exact bot identity or service destination.'); };
const scopeSchema = z.object({ service: z.enum(['github', 'jira', 'discord']), operation: text })
  .refine(({ service, operation }) => operations[operation]?.service === service || operation.startsWith(`${service}.`));

export function createBotServiceContext({ identities, services, fetchImpl, policyOptions, resolveDiscordTarget }) {
  if (!identities?.resolve || !identities?.list || !services?.read) throw new TypeError('Bot context requires identities and services');
  const resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl, policyOptions }) });
  const identityFor = async (bot, service) => {
    const selection = bot.identity?.[service];
    if (!selection) return null;
    const inventory = await identities.list();
    const matches = service === 'github' && selection.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selection.accountId)
      : inventory.filter((entry) => entry.id === selection.identityId);
    if (matches.length !== 1) refuse('BOT_IDENTITY_REQUIRED');
    const identity = await identities.resolve(matches[0].id, matches[0].revision);
    if (!identity.definition.kind.startsWith(`${service}-`)
      || service === 'github' && (selection.kind === 'app') !== (identity.definition.kind === 'github-app')) refuse('BOT_IDENTITY_REQUIRED');
    return { identityId: identity.id, identityRevision: identity.revision };
  };
  const repository = async (project) => {
    const current = await resolvePrivateRepositoryIdentity(project.path);
    if (!current.supported || current.bare) refuse('BOT_REPOSITORY_REQUIRED');
    const candidates = current.remotes.flatMap((remote) => {
      const parsed = parseGitHubRemoteUrl(remote.fetch.rawUrl);
      if (!parsed) return [];
      // The parser supports legacy remote display forms; reject credentials and
      // extra path components before granting autonomous destination authority.
      const normalized = remote.fetch.rawUrl.replace(/^git@github.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github.com\//, 'https://github.com/');
      const url = new URL(normalized);
      if (url.username || url.password || url.search || url.hash || url.port
        || !['https:', 'ssh:'].includes(url.protocol)
        || url.pathname.replace(/\.git$/, '') !== `/${parsed.owner}/${parsed.repo}`) return [];
      return [{ remote: remote.name, ...githubTarget.parse({ repositoryId: current.repositoryId, owner: parsed.owner, repo: parsed.repo }) }];
    });
    const selected = candidates.find((entry) => entry.remote === 'origin') ?? (candidates.length === 1 ? candidates[0] : null);
    if (!selected) refuse('BOT_REPOSITORY_AMBIGUOUS');
    const { remote, ...target } = selected;
    return { target, remote };
  };
  const github = async ({ project, bot, binding }) => {
    const { target } = await repository(project);
    const selected = binding ?? await identityFor(bot, 'github');
    if (!selected) refuse('BOT_IDENTITY_REQUIRED');
    if (binding?.target && JSON.stringify(binding.target) !== JSON.stringify(target)) refuse('BOT_DESTINATION_CHANGED');
    const credential = await resolve({ ...selected, service: 'github', target });
    return { binding: { identityId: selected.identityId, identityRevision: selected.identityRevision, target }, credential };
  };
  const author = async (request) => {
    const { credential } = await github(request);
    const id = credential.authority.providerAccountId.match(/^github\.com#([1-9][0-9]*)$/)?.[1];
    if (!id || !credential.username) refuse('BOT_GIT_AUTHOR_REQUIRED');
    return { name: credential.username, email: `${id}+${credential.username}@users.noreply.github.com` };
  };
  const serviceContext = async ({ project, bot, item, service, operation }) => {
    scopeSchema.parse({ service, operation });
    const result = {};
    if (service === 'github' && bot.identity?.github) result.github = (await github({ project, bot })).binding;
    if (service === 'jira' && bot.identity?.jira && item.source.kind === 'jira') {
      const identity = await identityFor(bot, 'jira');
      const issueKey = item.source.id;
      const target = jiraTarget.parse({ issueKey, projectKey: issueKey.replace(/-[1-9][0-9]*$/, '') });
      result.jira = { ...identity, target };
      if (operation === 'jira.transition' && bot.jira?.doneTransition) {
        const transitions = await services.read({ ...identity, target, operation: 'jira.transitions' });
        const transition = providerResult(z.array(z.object({ id: text, to: z.object({ id: z.string().regex(/^[1-9][0-9]*$/) }) })), transitions)
          .find((entry) => entry.id === bot.jira.doneTransition);
        if (!transition) refuse('BOT_JIRA_TRANSITION_UNAVAILABLE');
        result.jira.expectedStatusId = transition.to.id;
      }
    }
    if (service === 'discord' && bot.identity?.discord) {
      if (!resolveDiscordTarget) refuse('BOT_DISCORD_DESTINATION_REQUIRED');
      result.discord = { ...await identityFor(bot, 'discord'), target: discordTarget.parse(await resolveDiscordTarget({ project, bot, item })) };
    }
    return result;
  };
  return Object.freeze({ serviceContext, github, repository, author });
}
