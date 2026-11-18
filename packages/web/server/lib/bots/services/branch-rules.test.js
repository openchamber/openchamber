import { expect, it } from 'vitest';
import { readGitHubBranchRules } from './branch-rules.js';
import { BotServiceError } from './contracts.js';

const target = { repositoryId: 'repo-one', owner: 'acme', repo: 'app' };
const rule = { type: 'branch_name_pattern', parameters: { pattern: '^task/BUG-[0-9]+$', operator: 'regex', negate: false },
  ruleset_id: 7, ruleset_source: 'acme', ruleset_source_type: 'Organization' };

it('reads inherited rules on a proposed branch and preserves their parameters', async () => {
  const requests = [];

  const result = await readGitHubBranchRules({ request: async (input) => { requests.push(input); return [rule]; } }, target, 'task/BUG-1');

  expect(result).toEqual([rule]);
  expect(requests).toEqual([{ path: '/repos/acme/app/rules/branches/task%2FBUG-1?per_page=100&page=1' }]);
});

it('reads every rules page before returning a complete result', async () => {
  let pages = 0;

  const result = await readGitHubBranchRules({ request: async () => ++pages === 1 ? Array(100).fill(rule) : [{ type: 'required_signatures' }] }, target, 'task/BUG-1');

  expect(result).toHaveLength(101);
  expect(result.at(-1).type).toBe('required_signatures');
  expect(pages).toBe(2);
});

it('refuses an incomplete result at the read limit', async () => {
  let pages = 0;

  await expect(readGitHubBranchRules({ request: async () => { pages += 1; return Array(100).fill(rule); } }, target, 'task/BUG-1'))
    .rejects.toMatchObject({ code: 'BOT_GITHUB_RULES_INCOMPLETE' });

  expect(pages).toBe(10);
});

it.each([{}, [{ type: 'branch_name_pattern', parameters: 'invalid' }], [{ type: 'deletion', ruleset_enforcement_mode: 'disabled' }]])
  ('refuses malformed or non-active rule responses', async (response) => {
    await expect(readGitHubBranchRules({ request: async () => response }, target, 'task/BUG-1'))
      .rejects.toMatchObject({ code: 'BOT_SERVICE_RESPONSE_INVALID' });
  });

it('propagates provider denial without an empty-rules fallback', async () => {
  const denied = Object.assign(new Error('Denied'), { code: 'BOT_SERVICE_AUTH_REQUIRED' });

  await expect(readGitHubBranchRules({ request: async () => { throw denied; } }, target, 'task/BUG-1')).rejects.toBe(denied);
});

it('supports a plan-forbidden REST read only when GraphQL proves all rule owners empty', async () => {
  const denied = new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Plan refusal', 'needs-you', 403);
  const empty = { totalCount: 0, pageInfo: { hasNextPage: false } };
  const calls = [];

  const result = await readGitHubBranchRules({ request: async (input) => {
    calls.push(input);
    if (input.path !== '/graphql') throw denied;
    return { data: { repository: { rulesets: empty, branchProtectionRules: empty } } };
  } }, target, 'bot/new-item');

  expect(result).toEqual([]);
  expect(calls[1]).toMatchObject({ path: '/graphql', method: 'POST', readOnly: true });
});

it.each(['rulesets', 'branchProtectionRules'])('retains REST refusal when GraphQL has any %s', async (kind) => {
  const denied = new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Plan refusal', 'needs-you', 403);
  const repository = { rulesets: { totalCount: 0, pageInfo: { hasNextPage: false } },
    branchProtectionRules: { totalCount: 0, pageInfo: { hasNextPage: false } } };
  repository[kind].totalCount = 1;

  await expect(readGitHubBranchRules({ request: async ({ path }) => {
    if (path !== '/graphql') throw denied;
    return { data: { repository } };
  } }, target, 'bot/new-item')).rejects.toBe(denied);
});
