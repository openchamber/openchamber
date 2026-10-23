import { z } from 'zod';
import { BotServiceError, branch, parse, providerResult, revision, sha, text } from './contracts.js';

const gitRef = z.object({ ref: text, object: z.object({ sha }) });
const pullSchema = z.object({ number: revision, node_id: text, state: z.enum(['open', 'closed']),
  head: z.object({ sha, ref: branch, repo: z.object({ full_name: text }).nullable() }),
  base: z.object({ ref: branch, repo: z.object({ full_name: text }) }),
});

export function createGitHubAdapter(credential, target, { publishGit, beforeAdmission }) {
  const repository = `${target.owner}/${target.repo}`;
  const root = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const matchesRepo = (value) => value?.toLowerCase() === repository.toLowerCase();
  const graphql = async (query, variables, write = false) => {
    const response = await credential.request({ path: '/graphql', method: 'POST', body: { query, variables }, readOnly: !write });
    if (!response?.data || response.errors?.length) throw new BotServiceError('BOT_GITHUB_GRAPHQL_REJECTED',
      'GitHub could not authorize or complete the operation.', write ? 'outcome-unknown' : 'needs-you', 422);
    return response.data;
  };
  const readBranch = async (name, missingAllowed = false) => {
    parse(branch, name);
    let result;
    try { result = providerResult(gitRef, await credential.request({ path: `${root}/git/ref/heads/${encodeURIComponent(name)}` })); }
    catch (error) {
      if (missingAllowed && error.code === 'BOT_SERVICE_REJECTED' && error.status === 404) return null;
      throw error;
    }
    if (result.ref !== `refs/heads/${name}`) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'GitHub returned another branch.');
    return result.object.sha;
  };
  const readPull = async (number, headSha) => {
    parse(revision, number);
    const pull = providerResult(pullSchema, await credential.request({ path: `${root}/pulls/${number}` }));
    if (pull.number !== number || !matchesRepo(pull.base.repo.full_name) || !matchesRepo(pull.head.repo?.full_name)
      || headSha && pull.head.sha !== headSha) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub pull request or its head changed.');
    return pull;
  };
  const readAuthorization = async (input) => {
    const pull = await readPull(input.number);
    if (pull.head.ref !== input.branch) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The owned GitHub branch changed.');
    const result = await graphql(`query BotAuthorization($id:ID!) { node(id:$id) { ... on PullRequest {
      id number headRefName baseRefName headRefOid baseRefOid merged
      headRepository { nameWithOwner } baseRepository { nameWithOwner }
      autoMergeRequest { enabledAt } mergeQueueEntry { id }
    } } }`, { id: pull.node_id });
    const node = providerResult(z.object({ id: text, number: revision, headRefName: branch, baseRefName: branch,
      headRefOid: sha, baseRefOid: sha, merged: z.boolean(),
      headRepository: z.object({ nameWithOwner: text }), baseRepository: z.object({ nameWithOwner: text }),
      autoMergeRequest: z.object({ enabledAt: text }).nullable(), mergeQueueEntry: z.object({ id: text }).nullable(),
    }), result.node);
    if (node.id !== pull.node_id || node.number !== input.number || node.headRefName !== input.branch
      || node.baseRefName !== pull.base.ref || !matchesRepo(node.headRepository.nameWithOwner)
      || !matchesRepo(node.baseRepository.nameWithOwner)) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub authorization target changed.');
    return { id: node.id, number: node.number, headSha: node.headRefOid, baseSha: node.baseRefOid,
      merged: node.merged, autoMerge: node.autoMergeRequest !== null, queued: node.mergeQueueEntry !== null };
  };
  const revoke = async (operation, input, readOnly) => {
    let status = await readAuthorization(input);
    const field = operation === 'pr.disable-auto-merge' ? 'autoMerge' : 'queued';
    if (!status.merged && status[field] && !readOnly) {
      if (operation === 'pr.disable-auto-merge') await graphql(`mutation BotDisableAutoMerge($id:ID!) {
        disablePullRequestAutoMerge(input:{pullRequestId:$id}) { __typename }
      }`, { id: status.id }, true);
      else await graphql(`mutation BotDequeue($id:ID!) {
        dequeuePullRequest(input:{id:$id}) { __typename }
      }`, { id: status.id }, true);
      status = await readAuthorization(input);
    }
    if (!status.merged && status[field]) return { state: 'outcome-unknown' };
    return { state: 'succeeded', result: { number: input.number, headSha: status.headSha, merged: status.merged } };
  };
  const findPull = async (input) => {
    const query = new URLSearchParams({ state: 'all', head: `${target.owner}:${input.branch}`, base: input.base, per_page: '100' });
    const pulls = providerResult(z.array(pullSchema).max(100), await credential.request({ path: `${root}/pulls?${query}` }));
    if (pulls.length === 100) throw new BotServiceError('BOT_GITHUB_RECONCILIATION_INCOMPLETE', 'The unique bot branch has too many pull requests to reconcile.');
    const matches = pulls.filter((pull) => matchesRepo(pull.head.repo?.full_name) && matchesRepo(pull.base.repo.full_name)
      && pull.head.ref === input.branch && pull.base.ref === input.base && pull.head.sha === input.headSha);
    if (matches.length > 1) throw new BotServiceError('BOT_GITHUB_BRANCH_REUSED', 'The bot branch has more than one matching pull request.');
    return matches[0] ?? null;
  };
  const pullReceipt = (pull) => ({ number: pull.number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha });
  const readRules = async (name) => {
    parse(branch, name);
    const rules = providerResult(z.array(z.object({ type: text })).max(200),
      await credential.request({ path: `${root}/rules/branches/${encodeURIComponent(name)}` }));
    const response = await graphql(`query BotBranchRules($owner:String!,$repo:String!,$ref:String!) {
      repository(owner:$owner,name:$repo) { ref(qualifiedName:$ref) {
        target { ... on Commit { oid } }
        branchProtectionRule { requiresCommitSignatures requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks }
      } }
    }`, { owner: target.owner, repo: target.repo, ref: `refs/heads/${name}` });
    const ref = providerResult(z.object({ target: z.object({ oid: sha }), branchProtectionRule: z.object({
      requiresCommitSignatures: z.boolean(), requiresApprovingReviews: z.boolean(),
      requiredApprovingReviewCount: z.number().int().nonnegative(), requiresStatusChecks: z.boolean(),
    }).nullable() }), response.repository?.ref);
    return { branch: name, headSha: ref.target.oid, requiredSignatures: ref.branchProtectionRule?.requiresCommitSignatures === true
      || rules.some((rule) => rule.type === 'required_signatures'),
    mergeQueue: rules.some((rule) => rule.type === 'merge_queue'), legacyProtection: ref.branchProtectionRule,
    ruleTypes: rules.map((rule) => rule.type) };
  };
  return {
    async perform(operation, input) {
      if (['pr.disable-auto-merge', 'pr.dequeue'].includes(operation)) {
        const result = await revoke(operation, input, false);
        if (result.state !== 'succeeded') throw new BotServiceError('BOT_REMOTE_AUTHORIZATION_ACTIVE', 'Remote auto-merge may still be active.', 'outcome-unknown');
        return result.result;
      }
      if (operation === 'git.push') return publishGit({ credential, target, input, readBranch, readRules, graphql, root });
      if (operation === 'pr.open') {
        if (input.branch === input.base || await readBranch(input.branch) !== input.headSha) {
          throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The bot branch changed before the pull request was opened.');
        }
        await readBranch(input.base);
        const existing = await findPull(input);
        if (existing) return pullReceipt(existing);
        const pull = providerResult(pullSchema, await credential.request({ path: `${root}/pulls`, method: 'POST',
          body: { head: input.branch, base: input.base, title: input.title, body: input.body, draft: input.draft },
        }), true);
        if (!matchesRepo(pull.head.repo?.full_name) || !matchesRepo(pull.base.repo.full_name)
          || pull.head.sha !== input.headSha || pull.head.ref !== input.branch || pull.base.ref !== input.base) {
          throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The GitHub pull request receipt changed its target.', 'outcome-unknown');
        }
        return pullReceipt(pull);
      }
      const pull = await readPull(input.number, input.headSha);
      if (operation === 'pr.comment') {
        const comment = providerResult(z.object({ id: revision }), await credential.request({
          path: `${root}/issues/${input.number}/comments`, method: 'POST', body: { body: input.body },
        }), true);
        return { number: input.number, headSha: input.headSha, commented: true, commentId: comment.id };
      }
      if (pull.state !== 'open') throw new BotServiceError('BOT_GITHUB_PULL_CLOSED', 'The bot pull request is closed.');
      if (!input.baseSha || !input.branch || pull.head.ref !== input.branch) throw new BotServiceError('BOT_ADMISSION_TUPLE_REQUIRED', 'A fresh head, base and owned branch are required.');
      const rules = await readRules(pull.base.ref);
      if (rules.headSha !== input.baseSha) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub base changed before admission.');
      if (input.mode === 'queue') {
        if (!rules.mergeQueue) throw new BotServiceError('BOT_GITHUB_QUEUE_REQUIRED', 'This branch has no GitHub merge queue.');
        await beforeAdmission?.();
        const result = await graphql(`mutation BotEnqueue($id:ID!,$head:GitObjectID!) {
          enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,jump:false}) { mergeQueueEntry { id } }
        }`, { id: pull.node_id, head: input.headSha }, true);
        providerResult(z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: text }) }) }), result, true);
        return { number: input.number, headSha: input.headSha, status: 'enqueued' };
      }
      if (rules.requiredSignatures && input.mergeMethod === 'REBASE') {
        throw new BotServiceError('BOT_GITHUB_SIGNED_REBASE_DENIED', 'GitHub rebase merging cannot preserve verified bot signatures.');
      }
      await beforeAdmission?.();
      const result = await graphql(`mutation BotAutoMerge($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}) {
          pullRequest { headRefOid autoMergeRequest { enabledAt } }
        }
      }`, { id: pull.node_id, head: input.headSha, method: input.mergeMethod }, true);
      const enabled = providerResult(z.object({ enablePullRequestAutoMerge: z.object({ pullRequest: z.object({
        headRefOid: sha, autoMergeRequest: z.object({ enabledAt: text }),
      }) }) }), result, true);
      if (enabled.enablePullRequestAutoMerge.pullRequest.headRefOid !== input.headSha) {
        throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub head changed during auto-merge admission.', 'outcome-unknown');
      }
      return { number: input.number, headSha: input.headSha, status: 'pending' };
    },
    async reconcile(operation, input) {
      if (['pr.disable-auto-merge', 'pr.dequeue'].includes(operation)) return revoke(operation, input, true);
      if (operation === 'pr.comment') return { state: 'outcome-unknown' };
      if (operation === 'git.push') {
        const head = await readBranch(input.branch, true);
        return head === input.headSha ? { state: 'succeeded', result: { headSha: head, sourceHeadSha: input.headSha } }
          : { state: 'outcome-unknown' };
      }
      if (operation === 'pr.open') {
        const pull = await findPull(input);
        return pull ? { state: 'succeeded', result: pullReceipt(pull) } : { state: 'outcome-unknown' };
      }
      const pull = await readPull(input.number, input.headSha);
      const result = await graphql(`query BotQueuedPull($id:ID!) { node(id:$id) { ... on PullRequest {
        headRefOid mergeQueueEntry { id } autoMergeRequest { enabledAt } merged
      } } }`, { id: pull.node_id });
      const node = providerResult(z.object({ headRefOid: sha, merged: z.boolean(), mergeQueueEntry: z.object({ id: text }).nullable(),
        autoMergeRequest: z.object({ enabledAt: text }).nullable() }), result.node);
      return node.headRefOid === input.headSha && (node.mergeQueueEntry || node.merged || input.mode === 'auto-merge' && node.autoMergeRequest)
        ? { state: 'succeeded', result: { number: input.number, headSha: input.headSha,
          status: node.merged ? 'merged' : node.mergeQueueEntry ? 'enqueued' : 'pending' } }
        : { state: 'outcome-unknown' };
    },
    async read(operation, input) {
      if (operation === 'github.authorization') {
        const { id: _id, ...status } = await readAuthorization(input);
        return status;
      }
      if (operation === 'github.rules') return readRules(input.branch);
      if (operation === 'github.branch') return { headSha: await readBranch(input.branch, true) };
      if (operation === 'github.pull') {
        const pull = await readPull(input.number, input.headSha);
        return { ...pullReceipt(pull), state: pull.state };
      }
      throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This GitHub read is unsupported.', 'failed', 400);
    },
  };
}
