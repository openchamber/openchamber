import type { IconName } from '@/components/icon/icons';
import type { GitHistoryGraphRef } from './gitGraph';

type GitRefBadgeGroup = {
  refs: [GitHistoryGraphRef, ...GitHistoryGraphRef[]];
  icon: IconName;
};

type GitRefBadgePresentation = {
  primary: { ref: GitHistoryGraphRef; icon: IconName } | null;
  secondary: readonly GitRefBadgeGroup[];
};

export function getGitRefBadgeIcon(ref: GitHistoryGraphRef): IconName {
  switch (ref.kind) {
    case 'head':
      return 'target';
    case 'local':
      return 'git-branch';
    case 'remote':
      return 'cloud';
    case 'tag':
      return 'git-commit';
  }
}

export function buildGitRefBadgePresentation(refs: readonly GitHistoryGraphRef[]): GitRefBadgePresentation {
  // Input is model-ranked (current, upstream, base, others); preserve as-is.
  const nonTagRefs = refs.filter((ref) => ref.kind !== 'tag');
  const visibleRefs = nonTagRefs.length > 0 ? nonTagRefs : refs;
  const [primaryRef, ...secondaryRefs] = visibleRefs;
  const secondary: GitRefBadgeGroup[] = [];

  for (const ref of secondaryRefs) {
    const icon = getGitRefBadgeIcon(ref);
    const previous = secondary.at(-1);
    if (previous && previous.icon === icon && previous.refs[0].color === ref.color) {
      previous.refs.push(ref);
      continue;
    }
    secondary.push({ refs: [ref], icon });
  }

  return {
    primary: primaryRef ? { ref: primaryRef, icon: getGitRefBadgeIcon(primaryRef) } : null,
    secondary,
  };
}
