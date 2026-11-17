import { z } from 'zod';
import { BotServiceError, branch, githubTarget, parse, providerResult, revision, text } from './contracts.js';

const ruleSchema = z.object({
  type: text, parameters: z.record(z.string(), z.json()).optional(),
  ruleset_id: revision.optional(), ruleset_source: text.optional(),
  ruleset_source_type: z.enum(['Repository', 'Organization', 'Enterprise']).optional(),
  ruleset_enforcement_mode: z.literal('active').optional(),
});
const pageSchema = z.array(ruleSchema).max(100);
const ruleCount = z.object({ totalCount: z.number().int().nonnegative(), pageInfo: z.object({ hasNextPage: z.boolean() }) });

/** Includes active inherited rules for a proposed name, even before the ref exists. */
export async function readGitHubBranchRules(credential, target, name) {
  const repository = parse(githubTarget, target);
  parse(branch, name);
  const rules = [];
  for (let page = 1; page <= 10; page += 1) {
    let values;
    try {
      values = providerResult(pageSchema, await credential.request({
        path: `/repos/${repository.owner}/${repository.repo}/rules/branches/${encodeURIComponent(name)}?per_page=100&page=${page}`,
      }));
    } catch (error) {
      if (page !== 1 || !(error instanceof BotServiceError) || error.code !== 'BOT_SERVICE_AUTH_REQUIRED' || error.status !== 403) throw error;
      // Private Free repositories refuse REST rules reads even with repository access.
      // Only complete, authorized absence of both rule owners establishes emptiness.
      const response = await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: {
        query: `query BotRepositoryRuleOwners($owner:String!,$repo:String!) { repository(owner:$owner,name:$repo) {
          rulesets(first:1,includeParents:true) { totalCount pageInfo { hasNextPage } }
          branchProtectionRules(first:1) { totalCount pageInfo { hasNextPage } }
        } }`, variables: { owner: repository.owner, repo: repository.repo },
      } });
      if (response?.errors?.length) throw error;
      const owners = providerResult(z.object({ rulesets: ruleCount, branchProtectionRules: ruleCount }), response?.data?.repository);
      if ([owners.rulesets, owners.branchProtectionRules].every((owner) => owner.totalCount === 0 && !owner.pageInfo.hasNextPage)) return [];
      throw error;
    }
    rules.push(...values);
    if (values.length < 100) return rules;
  }
  throw new BotServiceError('BOT_GITHUB_RULES_INCOMPLETE', 'The effective project rules exceed the complete-read limit.');
}
