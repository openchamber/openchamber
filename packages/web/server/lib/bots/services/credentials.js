import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { BotServiceError, jiraOrigin, providerResult as parse, revision, snowflake, text } from './contracts.js';
import { createJiraOAuthRequest } from './jira-oauth.js';

const githubUser = z.object({ id: revision, login: text });
const tokenSchema = z.object({ token: text, expires_at: z.string().datetime(),
  repositories: z.array(z.object({ full_name: text })).optional() });
const unavailable = () => new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'Reconnect or select the exact bot identity.');

export function createCredentialResolver({ identities, http, jiraOAuthHttp, now = Date.now }) {
  return async ({ identityId, identityRevision, service, target }) => {
    const identity = await identities.resolve(identityId, identityRevision);
    const definition = identity.definition;
    if (!definition.kind.startsWith(`${service}-`)) throw unavailable();
    const beforeWrite = async () => {
      await identities.resolve(identityId, identityRevision);
      if (definition.kind === 'github-account') {
        const current = await identities.readGitHubAccount(definition.accountId, definition.credentialRevision);
        if (!current || current.credentialId !== definition.accountId
          || current.credentialRevision !== definition.credentialRevision) throw unavailable();
      }
    };
    let origin;
    let authorization;
    let providerAccountId;
    let credentialId = identityId;
    let credentialRevision = identityRevision;
    let username;
    let gitToken;
    let request;
    const resource = service === 'github' ? `${target.owner}/${target.repo}`
      : service === 'jira' ? target.projectKey ?? 'jira.search' : `${target.guildId}/${target.channelId}`;
    if (definition.kind === 'github-account') {
      const account = await identities.readGitHubAccount(definition.accountId, definition.credentialRevision);
      if (!account || account.credentialId !== definition.accountId
        || account.credentialRevision !== definition.credentialRevision
        || account.status !== 'valid' || !account.accessToken) throw unavailable();
      origin = 'https://api.github.com';
      authorization = `Bearer ${account.accessToken}`;
      const user = parse(githubUser, await http({ service, origin, resource, path: '/user', authorization }));
      providerAccountId = `github.com#${user.id}`;
      if (account.providerUserId !== providerAccountId) throw unavailable();
      credentialId = account.credentialId;
      credentialRevision = account.credentialRevision;
      username = user.login;
      gitToken = account.accessToken;
    } else if (definition.kind === 'github-app') {
      origin = 'https://api.github.com';
      const seconds = Math.floor(now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: definition.appId })).toString('base64url');
      let signature;
      try { signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(definition.privateKey)).toString('base64url'); }
      catch { throw unavailable(); }
      const jwt = `Bearer ${header}.${payload}.${signature}`;
      const app = parse(z.object({ id: revision, slug: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
        await http({ service, origin, resource, path: '/app', authorization: jwt }));
      if (String(app.id) !== definition.appId) throw unavailable();
      const installation = parse(z.object({ id: revision, app_id: revision, suspended_at: z.string().nullable() }),
        await http({ service, origin, resource, path: `/app/installations/${definition.installationId}`, authorization: jwt }));
      if (String(installation.id) !== definition.installationId || String(installation.app_id) !== definition.appId
        || installation.suspended_at !== null) throw unavailable();
      const token = parse(tokenSchema, await http({ service, origin, resource,
        path: `/app/installations/${definition.installationId}/access_tokens`, method: 'POST', authorization: jwt,
        body: { repositories: [target.repo], permissions: { contents: 'write', pull_requests: 'write', issues: 'write' } }, beforeWrite,
      }));
      if (Date.parse(token.expires_at) <= now() + 30_000
        || token.repositories && (token.repositories.length !== 1
          || token.repositories[0].full_name.toLowerCase() !== resource.toLowerCase())) throw unavailable();
      authorization = `Bearer ${token.token}`;
      gitToken = token.token;
      const bot = parse(githubUser.extend({ type: z.literal('Bot') }), await http({
        service, origin, resource, path: `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, authorization,
      }));
      if (bot.login.toLowerCase() !== `${app.slug}[bot]`.toLowerCase()) throw unavailable();
      providerAccountId = `github.com#${bot.id}`;
      username = bot.login;
    } else if (service === 'jira') {
      origin = jiraOrigin(definition.site);
      if (definition.kind === 'jira-oauth') request = await createJiraOAuthRequest({ definition, http: jiraOAuthHttp, resource, assertCurrent: beforeWrite, now });
      else authorization = `Basic ${Buffer.from(`${definition.email}:${definition.apiToken}`).toString('base64')}`;
      const user = parse(z.object({ accountId: text, active: z.literal(true) }),
        await (request ? request({ path: '/rest/api/3/myself' }) : http({ service, origin, resource, path: '/rest/api/3/myself', authorization })));
      providerAccountId = user.accountId;
      if (providerAccountId === 'unknown') throw unavailable();
    } else {
      origin = 'https://discord.com';
      authorization = `Bot ${definition.botToken}`;
      const app = parse(z.object({ id: snowflake, bot: z.object({ id: snowflake, bot: z.literal(true) }) }),
        await http({ service, origin, resource, path: '/api/v10/oauth2/applications/@me', authorization }));
      if (app.id !== definition.applicationId) throw unavailable();
      providerAccountId = app.bot.id;
    }
    const authority = { identityId, identityRevision, service, origin, credentialId, credentialRevision, providerAccountId };
    return {
      authority, definition, username, gitToken, assertCurrent: beforeWrite,
      request: request ?? ((input) => http({ ...input, service, origin, resource, authorization,
        beforeWrite: async () => { await input.beforeWrite?.(); await beforeWrite(); } })),
    };
  };
}
