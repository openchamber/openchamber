import { Button } from '@/components/ui/button';
import type { GitHubPullReference, PullStackMember } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { ChecksGlyph } from './ReferencePickerRow';
import { repositoryStateLook } from './referencePickerItems';

/** Supplemental row under the native map's layer; membership and navigation stay in PullStackRows. */
export function PullStackMemberRow({ member, reference, busy, onRetarget }: {
  member: PullStackMember; reference: GitHubPullReference; busy: boolean;
  onRetarget: () => void;
}) {
  const { t } = useI18n();
  const look = repositoryStateLook({ ...reference, ...member }, { ...reference.sourceRepo, ...member });
  const unknown = member.summary === 'unknown';
  const color = unknown && member.state === 'open' ? 'var(--surface-muted-foreground)' : look.color;
  return (
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
        <span style={{ color }}>{t(look.labelKey)}</span>
        <code dir="ltr" className="min-w-0 break-all">{member.head} → {member.base}</code>
        {unknown ? <span>{t('prStacks.unknown')}</span> : (
          <>
            <span className="inline-flex items-center gap-1">
              <ChecksGlyph checks={member.checks} />
              {member.checks && member.checks.state !== 'unknown'
                ? `${member.checks.success}/${member.checks.total} ${t('gitView.pr.checks.label')}` : t('prStacks.checksUnknown')}
            </span>
            {member.state === 'open' && member.mergeable === null ? <span>{t('prStacks.mergeabilityUnknown')}</span> : null}
          </>
        )}
        {member.state === 'open' ? member.behindBase === null
          ? <span>{t('prStacks.behindUnknown')}</span>
          : member.behindBase > 0 ? <span className="text-[var(--status-warning-text)]">{t(member.behindBase === 1 ? 'prStacks.behindSingle' : 'prStacks.behindPlural', { count: member.behindBase })}</span> : null : null}
        {member.mergedParent && !member.retargetTo && member.state === 'open' ? (
          <span className="text-[var(--status-warning-text)]">{t('prStacks.carriesMerged', { number: member.mergedParent.number })}</span>
        ) : null}
        {member.retargetTo && member.state === 'open' ? (
          <>
            <span className="text-[var(--status-warning-text)]">{t('prStacks.retargetTo', { base: member.retargetTo })}</span>
            <Button variant="outline" size="xs" disabled={busy} onClick={onRetarget}>{t('prStacks.retarget')}</Button>
          </>
        ) : null}
      </div>
  );
}
