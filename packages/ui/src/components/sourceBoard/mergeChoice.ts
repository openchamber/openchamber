import type { RememberedMergeMethod } from '@/components/views/git/mergeMethodPreference';
import { isKnownMergeMethod, type ChangeRequestSubmitRequirement, type MergeMethod, type PullRequestStack, type PullRequestStackLayer } from '@/lib/source-control/types';

type MergeChoice = {
  /** The methods the repository allows that this version has words for. */
  methods: MergeMethod[];
  /** The one the button uses: the remembered method while allowed, else the first. */
  method: MergeMethod | null;
  /** What still holds a change back from submission. */
  unmet: ChangeRequestSubmitRequirement[];
  /**
   * Why submit is held back when no unmet requirement says so: the
   * requirements could not be read, or the host says the change cannot be
   * submitted (an unmerged parent, a conflict).
   */
  hold: 'unreadable' | 'not-submittable' | null;
  /** Submit waits for the change's requirements, and holds back while one is unmet. */
  blocked: boolean;
};

/**
 * How the board offers to land a change request. A method a newer server
 * names that this version has no words for is left out, so it never breaks
 * the actions. Where the host names submit requirements
 * (`features.submitRequirements`), submit waits until they are read, stays
 * disabled while one is unsatisfied or could not be evaluated, and while the
 * host reports the change as not mergeable.
 */
export const mergeChoiceOf = ({ allowed, remembered, checksRequirements, requirements, requirementsUnreadable = false, mergeable = null }: {
  allowed: readonly string[];
  remembered: RememberedMergeMethod;
  checksRequirements: boolean;
  requirements: ChangeRequestSubmitRequirement[] | undefined;
  /** The read that names the requirements failed. */
  requirementsUnreadable?: boolean;
  /** The host's own answer, from the change's detail or status; null when it does not say. */
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

/**
 * The open layers below `number` that land with it, bottom first. GitHub
 * merges a layer of its own stack (one with a `number`) together with the open
 * layers below it; a change-based host submits every open change below a
 * change in its relation chain. A GitLab chain of merge requests by branch
 * merges one request at a time, so nothing lands with it there.
 */
export const landsWithIt = ({ stack, number, method }: {
  stack: PullRequestStack | null;
  number: number;
  method: MergeMethod | null;
}): PullRequestStackLayer[] => {
  if (!stack || !method || (method !== 'submit' && stack.number === null)) return [];
  const index = stack.layers.findIndex((layer) => layer.number === number);
  return index <= 0 ? [] : stack.layers.slice(0, index).filter((layer) => layer.state === 'open');
};
