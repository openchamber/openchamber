import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSession } from '@/sync/sync-context';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getLinkedIssues, parseLinkedIssueRef, type LinkedIssue } from '@/lib/linkedIssues';
import { linkedEntityLiveInvalidate, useLinkedEntityLive, type LinkedEntityLive } from '@/lib/linkedEntityLive';
import { setLinkedIssue } from '@/sync/session-actions';
import { WorkStatusCollapsibleSection, WorkStatusPill, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { WorkStatusLinkDialog } from './WorkStatusLinkDialog';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const STATE_COLOR: Record<LinkedEntityLive['state'], string> = {
  open: 'var(--pr-open)',
  closed: 'var(--pr-closed)',
  merged: 'var(--pr-merged)',
};

const STATE_LABEL_KEY: Record<LinkedEntityLive['state'], I18nKey> = {
  open: 'forge.state.open',
  closed: 'forge.state.closed',
  merged: 'forge.state.merged',
};

/**
 * One linked issue/PR as a live card.
 *
 * When the entry resolves to a forge entity and the runtime carries the
 * provider's API, the row fetches current state (open/merged/closed, draft,
 * freshest title) on mount and on demand — never on an interval. The snapshot
 * stays the fallback for everything the live fetch has not answered yet:
 * loading keeps the snapshot row with a spinner, a failed fetch keeps it with
 * a muted "live unavailable" marker instead of silently looking stale.
 */
const LinkedIssueRow: React.FC<{
  entry: LinkedIssue;
  sessionId: string | null;
  directory: string | null | undefined;
}> = ({ entry, sessionId, directory }) => {
  const { t } = useI18n();
  const ref = React.useMemo(() => parseLinkedIssueRef(entry), [entry]);
  const providerKind = entry.provider ?? ref?.provider ?? null;
  const apis = getRegisteredRuntimeAPIs();
  const canLive = Boolean(
    directory
    && ref
    && ((providerKind === 'github' && apis?.github)
      || (providerKind === 'gitlab' && apis?.gitlab)
      || (providerKind === 'gitea' && apis?.gitea)),
  );
  const { live, loading, unavailable, refresh } = useLinkedEntityLive(entry, canLive ? directory : null);
  const [unlinking, setUnlinking] = React.useState(false);

  const handleUnlink = React.useCallback(async () => {
    if (!sessionId || !directory || unlinking) return;
    if (!window.confirm(t('chat.workStatus.linkedIssues.unlinkConfirm'))) return;
    setUnlinking(true);
    try {
      await setLinkedIssue(sessionId, directory, entry, false);
      linkedEntityLiveInvalidate(entry.id);
    } catch {
      toast.error(t('chat.workStatus.linkedIssues.unlinkFailed'));
    } finally {
      setUnlinking(false);
    }
  }, [directory, entry, sessionId, t, unlinking]);

  const openInBrowser = React.useCallback(() => {
    if (typeof window !== 'undefined') {
      window.open(entry.url, '_blank', 'noopener,noreferrer');
    }
  }, [entry.url]);

  const stateLabel = live ? t(STATE_LABEL_KEY[live.state]) : null;

  // The live fetch is the freshest word on the title; the snapshot covers
  // everything the fetch has not answered yet (initial loading, failure).
  const title = live?.title ?? entry.title;

  const leading = entry.authorAvatarUrl ? (
    <img src={entry.authorAvatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" />
  ) : (
    <Icon
      name={entry.kind === 'pull' ? 'git-pull-request' : 'error-warning'}
      className="size-4 shrink-0 text-muted-foreground"
    />
  );

  // A plain row, not WorkStatusRow: the card carries its own controls
  // (refresh, unlink) next to the number, which a full-row button cannot
  // contain without nesting buttons.
  return (
    <div className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left">
      {leading}
      <button
        type="button"
        onClick={openInBrowser}
        aria-label={t('chat.workStatus.linkedIssues.open', { number: entry.number })}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="truncate">{title}</span>
        {canLive && unavailable ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('chat.workStatus.linkedIssues.liveUnavailable')}
          </span>
        ) : null}
        {canLive && loading ? <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      </button>
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums">
        {live ? (
          <span
            role="img"
            aria-label={stateLabel ?? undefined}
            title={stateLabel ?? undefined}
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: STATE_COLOR[live.state] }}
          />
        ) : null}
        {live?.draft ? <WorkStatusPill>{t('chat.workStatus.pr.draft')}</WorkStatusPill> : null}
        <WorkStatusValue tone="muted">{`#${entry.number}`}</WorkStatusValue>
        {canLive ? (
          <button
            type="button"
            aria-label={t('chat.workStatus.linkedIssues.liveRefresh')}
            title={t('chat.workStatus.linkedIssues.liveRefresh')}
            disabled={loading}
            onClick={refresh}
            className="rounded p-0.5 text-muted-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="refresh" className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t('chat.workStatus.linkedIssues.unlink')}
          title={t('chat.workStatus.linkedIssues.unlink')}
          disabled={unlinking}
          onClick={handleUnlink}
          className={cn(
            'rounded p-0.5 text-muted-foreground transition-colors',
            'hover:text-[var(--status-error)] disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <Icon name={unlinking ? 'loader-4' : 'delete-bin'} className={cn('size-3.5', unlinking && 'animate-spin')} />
        </button>
      </span>
    </div>
  );
};

/**
 * What is loaded into the agent's context: the git-forge threads this session
 * was pointed at (live state cards plus link/unlink controls), and how much
 * ambient material is available.
 *
 * Agents are deliberately absent — an agent is who does the work, not material
 * the work is done with. Tools are absent for want of an honest source:
 * `Agent.tools` is a per-agent override map, not a registry, so its size would
 * report something other than "tools available".
 */
export const WorkStatusContextSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const [linkDialogOpen, setLinkDialogOpen] = React.useState(false);

  const session = useSession(sessionId ?? '', directory ?? undefined);
  const skills = useSkillsStore((state) => state.skills);
  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );
  // The session's server-confirmed directory is the authoritative address for
  // forge lookups; the prop only covers drafts with no session yet.
  const sessionDirectory = session?.directory ?? directory;

  // Skills were previously fetched only when the composer's slash autocomplete
  // opened, so this row reported whatever count happened to be cached — often
  // none — until the user typed "/". The panel states a count, so it is the
  // panel's business to have one. Re-run per directory because skills are
  // discovered relative to the active project. No background-network wrap
  // here: `loadSkills` already gates its own fetch, and wrapping it again
  // would hold a second slot idle for the length of the first.
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  React.useEffect(() => {
    void loadSkills();
  }, [directory, loadSkills]);

  const linked = React.useMemo(() => getLinkedIssues(session), [session]);
  // Connected servers only. A disabled server contributes nothing to the
  // context, so counting it here contradicts the MCP section right above,
  // which shows the same servers switched off.
  const mcpCount = React.useMemo(
    () => Object.values(mcpStatus ?? {}).filter((entry) => entry?.status === 'connected').length,
    [mcpStatus],
  );

  useReportWorkStatusPresence('context-sources', linked.length > 0 || skills.length > 0 || mcpCount > 0);

  if (linked.length === 0 && skills.length === 0 && mcpCount === 0) return null;

  // The heading names what is distinctive about this session when there is
  // something — an attached thread — and falls back to the ambient counts
  // when there is not. `1 · 33 · 2` said nothing without opening the section.
  const issueCount = linked.filter((entry) => entry.kind === 'issue').length;
  const prCount = linked.length - issueCount;
  const summaryParts: string[] = [];
  if (issueCount > 0) {
    summaryParts.push(issueCount === 1
      ? t('chat.workStatus.breakdown.issueCountSingle', { count: issueCount })
      : t('chat.workStatus.breakdown.issueCountPlural', { count: issueCount }));
  }
  if (prCount > 0) {
    summaryParts.push(prCount === 1
      ? t('chat.workStatus.breakdown.prCountSingle', { count: prCount })
      : t('chat.workStatus.breakdown.prCountPlural', { count: prCount }));
  }
  if (summaryParts.length === 0) {
    if (skills.length > 0) {
      summaryParts.push(skills.length === 1
        ? t('chat.workStatus.breakdown.skillCountSingle', { count: skills.length })
        : t('chat.workStatus.breakdown.skillCountPlural', { count: skills.length }));
    }
    if (mcpCount > 0) {
      summaryParts.push(mcpCount === 1
        ? t('chat.workStatus.breakdown.mcpCountSingle', { count: mcpCount })
        : t('chat.workStatus.breakdown.mcpCountPlural', { count: mcpCount }));
    }
  }

  const hasSessionContext = Boolean(sessionId && sessionDirectory);

  return (
    <WorkStatusCollapsibleSection
      id="context-sources"
      title={t('chat.workStatus.section.contextBreakdown')}
      icon="stack"
      summary={summaryParts.join(' · ')}
      action={(
        <Button
          size="xs"
          variant="ghost"
          disabled={!hasSessionContext}
          onClick={() => setLinkDialogOpen(true)}
          aria-label={t('chat.workStatus.linkedIssues.link')}
          title={t('chat.workStatus.linkedIssues.link')}
        >
          <Icon name="add" className="size-3.5" />
          <span>{t('chat.workStatus.linkedIssues.link')}</span>
        </Button>
      )}
    >
      {/* Attached threads first: they are specific to this session, while the
          counts below describe the workspace. */}
      {linked.map((entry) => (
        <LinkedIssueRow
          key={entry.id}
          entry={entry}
          sessionId={sessionId}
          directory={sessionDirectory}
        />
      ))}

      {linked.length === 0 ? (
        <WorkStatusRow muted label={t('chat.workStatus.linkedIssues.empty')} />
      ) : null}

      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.skills')}
        value={<WorkStatusValue>{skills.length}</WorkStatusValue>}
      />
      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.mcp')}
        value={<WorkStatusValue>{mcpCount}</WorkStatusValue>}
      />

      <WorkStatusLinkDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        sessionId={sessionId}
        directory={sessionDirectory}
      />
    </WorkStatusCollapsibleSection>
  );
};
