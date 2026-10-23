/** Wiring: createProductionBotPullRequests({ context, services, getFixLoopRuntime,
 * receiveFeedback, reviewApps }) returns { pullRequests, botWatch }.
 * Supply botWatch to createFixLoopRuntime({ ...existingDependencies, botWatch }).
 * getFixLoopRuntime() and receiveFeedback(projectId,itemId,event) are late-bound
 * closures over the composed runtimes. reviewApps is an administrator-selected
 * [{ slug, appId }] allowlist, including AI review apps the bot may act on.
 */
import { z } from 'zod';
import { BotServiceError, providerResult, sha, text } from './services/contracts.js';

const fail = (code) => { throw new BotServiceError(code, 'The exact bot pull request authority could not be verified.'); };
const reviewAppsSchema = z.array(z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]+$/), appId: z.number().int().positive() }).strict()).max(100);

// This narrow Octokit read interface feeds the existing GitHub feedback owner.
// Every method uses the one operation-scoped credential resolver and fixed HTTP
// boundary. It exposes no generic mutation or account-selection capability.
const readerFor = (credential, authority) => {
  const get = (path) => credential.request({ path }).then((data) => ({ data }));
  return {
    graphql: async (query, variables) => {
      const response = await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: { query, variables } });
      if (response.errors?.length || !response.data) fail('BOT_GITHUB_FEEDBACK_FAILED');
      const pull = response.data.repository?.pullRequest;
      if (pull && (pull.headRefName !== `bot/${authority.itemId}`
        || pull.headRepository?.owner?.login.toLowerCase() !== authority.target.owner.toLowerCase()
        || pull.headRepository?.name.toLowerCase() !== authority.target.repo.toLowerCase())) fail('BOT_GITHUB_PULL_CHANGED');
      return response.data;
    },
    rest: {
      repos: { getCollaboratorPermissionLevel: ({ owner, repo, username }) => get(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`) },
      checks: { listAnnotations: ({ owner, repo, check_run_id, per_page }) => get(`/repos/${owner}/${repo}/check-runs/${check_run_id}/annotations?per_page=${per_page}`) },
      actions: {
        getJobForWorkflowRun: ({ owner, repo, job_id }) => get(`/repos/${owner}/${repo}/actions/jobs/${job_id}`),
        downloadJobLogsForWorkflowRun: ({ owner, repo, job_id }) => get(`/repos/${owner}/${repo}/actions/jobs/${job_id}/logs`),
      },
    },
  };
};

export function createProductionBotPullRequests({ context, services, getFixLoopRuntime, receiveFeedback, reviewApps }) {
  if (!context?.github || !services?.read || !getFixLoopRuntime || !receiveFeedback) throw new TypeError('Bot PR adapters require context, services and runtime callbacks');
  const approvedApps = reviewAppsSchema.parse(reviewApps);
  const authorityFor = async ({ project, bot, item }) => {
    if (!item.pr || item.branch !== `bot/${item.id}` || !item.worktree || !item.sessions.fixing || item.botId !== bot.id) fail('BOT_PULL_REQUEST_REQUIRED');
    const { binding } = await context.github({ project, bot });
    return { project: { id: project.id, path: project.path }, botId: bot.id, itemId: item.id, ...binding };
  };
  const credentialFor = async (authority) => (await context.github({ project: authority.project,
    binding: { identityId: authority.identityId, identityRevision: authority.identityRevision, target: authority.target } })).credential;
  const botWatch = Object.freeze({
    async getOctokit(authority) { return readerFor(await credentialFor(authority), authority); },
    deliver: (authority, event) => receiveFeedback(authority.project.id, authority.itemId, event),
    async authorizeApp(authority, author) {
      const selected = approvedApps.find((entry) => `${entry.slug}[bot]`.toLowerCase() === author.login.toLowerCase());
      if (!author.bot || !selected) return false;
      const credential = await credentialFor(authority);
      const app = providerResult(z.object({ id: z.number().int().positive(), slug: text }),
        await credential.request({ path: `/apps/${encodeURIComponent(selected.slug)}` }));
      const user = providerResult(z.object({ id: z.number().int().positive(), login: text, type: z.literal('Bot') }),
        await credential.request({ path: `/users/${encodeURIComponent(author.login)}` }));
      if (app.id !== selected.appId || app.slug.toLowerCase() !== selected.slug.toLowerCase()
        || user.login.toLowerCase() !== author.login.toLowerCase()) fail('BOT_REVIEW_APP_CHANGED');
      return true;
    },
  });
  const readStatus = async (request) => {
    const authority = await authorityFor(request);
    const credential = await credentialFor(authority);
    const { target } = authority;
    // Existing service owner verifies the repository, pull number and branch.
    const pull = await services.read({ identityId: authority.identityId, identityRevision: authority.identityRevision,
      target, operation: 'github.pull', input: { number: request.item.pr.number } });
    if (pull.head !== request.item.branch) fail('BOT_GITHUB_PULL_CHANGED');
    const response = await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: {
      query: `query BotPullAdmission($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) {
        pullRequest(number:$number) { number headRefOid baseRefOid headRefName baseRefName merged reviewDecision
          headRepository { nameWithOwner } baseRepository { nameWithOwner } }
      } }`, variables: { owner: target.owner, repo: target.repo, number: request.item.pr.number },
    } });
    if (response.errors?.length) fail('BOT_GITHUB_FEEDBACK_FAILED');
    const status = providerResult(z.object({ number: z.number().int().positive(), headRefOid: sha, baseRefOid: sha,
      headRefName: text, baseRefName: text, merged: z.boolean(), reviewDecision: z.string().nullable(),
      headRepository: z.object({ nameWithOwner: text }), baseRepository: z.object({ nameWithOwner: text }),
    }), response.data?.repository?.pullRequest);
    const repository = `${target.owner}/${target.repo}`.toLowerCase();
    if (status.number !== request.item.pr.number || status.headRefName !== request.item.branch || status.headRefOid !== pull.headSha
      || status.baseRefName !== pull.base || status.headRepository.nameWithOwner.toLowerCase() !== repository
      || status.baseRepository.nameWithOwner.toLowerCase() !== repository) fail('BOT_GITHUB_PULL_CHANGED');
    const rules = await services.read({ identityId: authority.identityId, identityRevision: authority.identityRevision,
      target, operation: 'github.rules', input: { branch: pull.base } });
    return { headSha: status.headRefOid, baseSha: status.baseRefOid, merged: status.merged,
      approved: status.reviewDecision === 'APPROVED', mergeMode: rules.mergeQueue ? 'queue' : 'auto-merge' };
  };
  const attach = async (request) => {
    const authority = await authorityFor(request);
    return getFixLoopRuntime().createBotWatch({ sessionId: request.item.sessions.fixing, directory: request.item.worktree,
      owner: authority.target.owner, repo: authority.target.repo, number: request.item.pr.number,
      branch: request.item.branch, url: request.item.pr.url, title: request.item.title }, authority);
  };
  const pullRequests = Object.freeze({
    async ensureLoop(request) {
      await readStatus(request);
      return attach(request);
    },
    async read(request) {
      const result = await readStatus(request);
      if (!result.merged) await attach(request);
      return result;
    },
    async stop(request) {
      if (!request.item.pr) return;
      if (request.item.botId !== request.bot.id) fail('BOT_PULL_REQUEST_REQUIRED');
      await getFixLoopRuntime().stopBotWatch({ projectId: request.project.id, botId: request.bot.id, itemId: request.item.id });
    },
  });
  return Object.freeze({ pullRequests, botWatch });
}
