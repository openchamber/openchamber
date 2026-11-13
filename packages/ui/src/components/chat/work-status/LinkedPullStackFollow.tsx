import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useRepositoryReadContext } from '@/components/references/referenceSources';
import { usePullStack } from '@/components/references/usePullStack';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { getRepositoryThreadRef, type LinkedIssue } from '@/lib/linkedIssues';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { getRuntimeKey } from '@/lib/runtime-switch';
import * as sessionActions from '@/sync/session-actions';
import { shouldShowStackFollow, type StackMembership } from './useLinkedPullStackMembership';

/** A following link stores only the anchor PR; this control reads its current membership on demand. */
export function LinkedPullStackFollow(props: { entry: LinkedIssue; sessionId: string | null; directory: string | null; membership: StackMembership }) {
  const matcher = useRepositoryUrlMatcher();
  const ref = getRepositoryThreadRef(props.entry, matcher);
  if (isVSCodeRuntime() || props.entry.kind !== 'pull' || !supportsGitHubAutomation(ref) || !props.directory || !props.sessionId) return null;
  if (!shouldShowStackFollow(props.membership, props.entry.followStack === true)) return null;
  return <FollowControl entry={props.entry} sessionId={props.sessionId} directory={props.directory} />;
}

function FollowControl({ entry, directory, sessionId }: {
  entry: Extract<LinkedIssue, { kind: 'issue' | 'pull' }>; directory: string; sessionId: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const bound = useRepositoryReadContext(directory);
  const matcher = useRepositoryUrlMatcher();
  const ref = getRepositoryThreadRef(entry, matcher);
  const pull = React.useMemo(() => ({ owner: ref?.owner ?? '', repo: ref?.repo ?? '', number: entry.number }), [entry.number, ref?.owner, ref?.repo]);
  const context = bound && bound !== 'missing' && supportsGitHubAutomation(bound) ? bound : null;
  const live = usePullStack(context, pull, entry.followStack === true);
  const description = entry.followStack
    ? `${t('prStacks.follow')}\n${live.stack ? live.stack.members.map((member) => `#${member.number} ${member.title}`).join('\n') : t('prStacks.unknown')}`
    : t('prStacks.follow');
  return (
    <Button variant="chip" size="xs" aria-label={t('prStacks.follow')} title={description}
      aria-pressed={entry.followStack === true} disabled={busy} onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        const runtime = getRuntimeKey();
        void sessionActions.setLinkedIssue(sessionId, directory, { ...entry, followStack: entry.followStack ? undefined : true }, true)
          .catch((error) => {
            if (getRuntimeKey() === runtime) toast.error(t('prStacks.followFailed'), { description: error instanceof Error ? error.message : String(error) });
          }).finally(() => setBusy(false));
      }}>
      <Icon name={busy ? 'loader-4' : 'stack'} className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
      {entry.followStack && live.stack ? <span className="tabular-nums">{live.stack.members.length}</span> : null}
    </Button>
  );
}
