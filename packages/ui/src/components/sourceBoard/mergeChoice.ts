import type { RememberedMergeMethod } from '@/components/views/git/mergeMethodPreference';
import { isKnownMergeMethod, type ChangeRequestSubmitRequirement, type MergeMethod, type PullRequestStack, type PullRequestStackLayer } from '@/lib/source-control/types';

type MergeChoice = {
  methods: MergeMethod[];
  method: MergeMethod | null;
  unmet: ChangeRequestSubmitRequirement[];
  hold: 'unreadable' | 'not-submittable' | null;
  blocked: boolean;
};

export const mergeChoiceOf = ({ allowed, remembered, checksRequirements, requirements, requirementsUnreadable = false, mergeable = null }: {
  allowed: readonly string[];
  remembered: RememberedMergeMethod;
  checksRequirements: boolean;
  requirements: ChangeRequestSubmitRequirement[] | undefined;
  requirementsUnreadable?: boolean;
  mergeable?: boolean | null;
}): MergeChoice => {
  const methods = allowed.filter(isKnownMergeMethod);
  const method = methods.find((candidate) => candidate === remembered) ?? methods[0] ?? null;
  const submits = method === 'submit' && checksRequirements;
  const unmet = submits && requirements
    ? requirements.filter((requirement) => requirement.status === 'unsatisfied' || requirement.status === 'error')
    : [];
  const hold = !submits || unmet.length > 0 ? null
    : !requirements && requirementsUnreadable ? 'unreadable'
      : mergeable === false ? 'not-submittable'
        : null;
  return { methods, method, unmet, hold, blocked: submits && (!requirements || unmet.length > 0 || mergeable === false) };
};

export const landsWithIt = ({ stack, number, method }: {
  stack: PullRequestStack | null;
  number: number;
  method: MergeMethod | null;
}): PullRequestStackLayer[] => {
  if (!stack || !method || (method !== 'submit' && stack.number === null)) return [];
  const index = stack.layers.findIndex((layer) => layer.number === number);
  return index <= 0 ? [] : stack.layers.slice(0, index).filter((layer) => layer.state === 'open');
};
