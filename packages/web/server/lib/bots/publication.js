import { BotServiceError } from './services/contracts.js';

const publicationKinds = new Set(['git.push', 'pr.open', 'pr.comment', 'pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue']);
export const botPublicationBranch = (item) => item.publicationBranch ?? item.branch;
export const botPushInput = (item, snapshot) => {
  const input = { directory: item.worktree, branch: botPublicationBranch(item), headSha: snapshot.headSha,
    baseSha: snapshot.remoteSha ?? snapshot.baseSha, expectedRemoteSha: snapshot.remoteSha, base: snapshot.baseBranch };
  if (item.publicationBranch !== undefined) input.localBranch = item.branch;
  return input;
};
const hasLegacyFixing = (item, execution) => item.publicationBranch === undefined
  && Object.values(execution.data.runs ?? {}).some((run) => run.stage === 'fixing' && run.context?.repositoryRules === undefined);

/** Stage context is historical; only the private checkout owner can reserve a name. */
export function createBotPublication({ worktrees, services, serviceContext, journal, mutate }) {
  const repositoryContext = async ({ project, bot, item, stage, round }) => {
    const execution = await journal.read(project.id, item.id);
    const captured = execution.data.runs?.[`${stage}:${round}`];
    if (captured) return captured.context?.repositoryRules;
    if (stage === 'fixing' && hasLegacyFixing(item, execution)) return undefined;
    const binding = (await serviceContext({ project, bot, item, service: 'github', operation: 'github.branch-rules' })).github;
    if (!binding) throw new BotServiceError('BOT_IDENTITY_REQUIRED', 'Select the bot GitHub identity before reading project rules.');
    const branch = botPublicationBranch(item);
    const rules = await services.read({ ...binding, scope: { project, bot, item }, operation: 'github.branch-rules', input: { branch } });
    const result = { branch, rules };
    if (stage === 'investigation' && item.source.kind === 'jira' && bot.identity.jira) {
      const jira = (await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.issue' })).jira;
      if (!jira) throw new BotServiceError('BOT_IDENTITY_REQUIRED', 'Select the source issue identity before investigating its conventions.');
      result.sourceIssue = await services.read({ ...jira, scope: { project, bot, item }, operation: 'jira.issue' });
    }
    return result;
  };
  return {
    repositoryContext,
    assertRemote(item, snapshot, key) {
      if (item.publicationBranch === undefined || item.effects.some((effect) => effect.key === key && effect.kind === 'git.push')) return;
      const published = item.effects.findLast((effect) => effect.kind === 'git.push' && effect.state === 'succeeded');
      if (snapshot.remoteSha !== (published?.receipt.sha ?? null)) {
        throw new BotServiceError('BOT_GIT_REMOTE_CHANGED', 'The reserved remote branch changed outside this item publication.');
      }
    },
    async bind({ project, bot, item, investigation }) {
      // Captured operations keep their historical destination and digests.
      const execution = await journal.read(project.id, item.id);
      if (hasLegacyFixing(item, execution)) return item;
      if (item.publicationBranch === undefined && (item.pr || item.effects.some((effect) => publicationKinds.has(effect.kind))
        || Object.values(execution.operations).some((request) => publicationKinds.has(request.prepared?.operation)))) return item;
      let branch = item.publicationBranch ?? investigation?.publicationBranch;
      if (!branch) {
        const context = await repositoryContext({ project, bot, item, stage: 'investigation', round: 0 });
        if (context?.rules.some((rule) => rule.type === 'branch_name_pattern')) {
          throw new BotServiceError('BOT_PUBLICATION_BRANCH_REQUIRED', 'The project naming rules require a compliant publication branch proposal.');
        }
        branch = item.branch;
      }
      const owned = await worktrees.bindPublication({ project, bot, item, branch });
      if (item.publicationBranch !== undefined && item.publicationBranch !== owned.publicationBranch) {
        throw new BotServiceError('BOT_PUBLICATION_BRANCH_CHANGED', 'The reserved publication branch differs from the item.');
      }
      if (item.publicationBranch === owned.publicationBranch) return item;
      return mutate(project.id, item.id, (current) => ({ ...current, publicationBranch: owned.publicationBranch }));
    },
  };
}
