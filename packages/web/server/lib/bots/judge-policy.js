import { resolvePolicyPeople } from './repository-policy.js';

/** The model proposes a verdict; repository policy grants its authority. */
export const admitBotJudgment = ({ output, policy, evaluation, snapshot }) => {
  const owners = [...new Set([...evaluation.owners, ...output.reviewers])];
  let reviewers = [];
  let unresolved = null;
  if (owners.length) {
    const people = resolvePolicyPeople(policy, { owners, service: 'github' });
    if (people.status === 'resolved') reviewers = people.people.map((person) => person.github);
    else unresolved = people.reason;
  }
  const decision = evaluation.level === 'human' ? 'review' : unresolved ? 'ask' : output.decision;
  const questions = [...output.questions, ...(unresolved ? [unresolved] : [])];
  return {
    requiresAnswer: decision === 'ask' || Boolean(unresolved),
    judgment: { decision, reason: evaluation.level === 'human' ? `${evaluation.reason}. Judge: ${output.reason}` : unresolved ?? output.reason,
      reviewers, questions, headSha: snapshot.headSha, baseSha: snapshot.baseSha, policyFingerprint: evaluation.policyFingerprint },
  };
};
