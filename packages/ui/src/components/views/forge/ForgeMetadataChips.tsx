import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { ForgeIssue, ForgePullRequest, ForgeUser } from '@/lib/forge/types';

interface ForgeMetadataChipsProps {
  kind: 'pull' | 'issue';
  pr?: ForgePullRequest | null;
  issue?: ForgeIssue | null;
}

const chipClassName =
  'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface-elevated px-2 py-0.5 typography-micro text-foreground';

const avatarSize = 'size-3.5 rounded-full';

/** GitHub label colors arrive without the `#` prefix; normalize both spellings. */
const resolveLabelColor = (color?: string): string | null => {
  if (!color) return null;
  const value = color.trim();
  if (!value) return null;
  return value.startsWith('#') ? value : `#${value}`;
};

const Avatar: React.FC<{ user: ForgeUser }> = ({ user }) => {
  const initial = (user.login || user.name || '?').charAt(0).toUpperCase();
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt={user.login} className={`${avatarSize} object-cover`} />;
  }
  return (
    <span className={`${avatarSize} flex items-center justify-center bg-interactive-hover text-[10px] font-medium text-foreground`}>
      {initial}
    </span>
  );
};

/**
 * Metadata chips for a pull request or issue: labels, assignees, milestone,
 * author, created/updated dates, and (for PRs) the base→head branch pair.
 * Pure presentation — all data arrives via props. Renders nothing when every
 * metadata group is absent.
 */
export const ForgeMetadataChips = React.memo<ForgeMetadataChipsProps>(function ForgeMetadataChips({ kind, pr, issue }) {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  const entity = pr ?? issue;
  if (!entity) return null;

  const labels = entity.labels ?? [];
  const assignees = entity.assignees ?? [];
  const pull = pr ?? null;
  const baseRef = pull?.base?.ref;
  const headRef = pull?.head?.ref;
  const hasAny =
    labels.length > 0
    || assignees.length > 0
    || Boolean(entity.milestone)
    || Boolean(entity.author)
    || Boolean(entity.createdAt)
    || Boolean(entity.updatedAt)
    || (kind === 'pull' && Boolean(baseRef && headRef));

  if (!hasAny) return null;

  const formatDate = (value?: string): string => {
    if (!value) return '';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return formatDateTimeForPreference(ts, timeFormatPreference, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t('forge.section.metadata')}
    >
      {labels.map((label) => {
        const color = resolveLabelColor(label.color);
        return (
          <span key={label.name} className={chipClassName} title={label.description || label.name}>
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: color ?? 'var(--status-info)' }}
            />
            {label.name}
          </span>
        );
      })}

      {assignees.map((assignee) => (
        <span key={assignee.id} className={chipClassName} title={assignee.login}>
          <Avatar user={assignee} />
          {assignee.login}
        </span>
      ))}

      {entity.milestone ? (
        <span className={chipClassName} title={entity.milestone.title}>
          <Icon name="target" className="size-3 text-muted-foreground" />
          {entity.milestone.title}
        </span>
      ) : null}

      {entity.author ? (
        <span className={chipClassName} title={`${t('forge.author')}: ${entity.author.login}`}>
          <Avatar user={entity.author} />
          {entity.author.login}
        </span>
      ) : null}

      {entity.createdAt ? (
        <span className={chipClassName} title={`${t('forge.created')}: ${formatDate(entity.createdAt)}`}>
          <Icon name="calendar" className="size-3 text-muted-foreground" />
          {formatDate(entity.createdAt)}
        </span>
      ) : null}

      {entity.updatedAt ? (
        <span className={chipClassName} title={`${t('forge.updated')}: ${formatDate(entity.updatedAt)}`}>
          <Icon name="refresh" className="size-3 text-muted-foreground" />
          {formatDate(entity.updatedAt)}
        </span>
      ) : null}

      {kind === 'pull' && baseRef && headRef ? (
        <span
          className={chipClassName}
          title={t('forge.baseToHead', { base: baseRef, head: headRef })}
        >
          <code className="font-mono">{baseRef}</code>
          <Icon name="arrow-go-forward" className="size-3 text-muted-foreground" />
          <code className="font-mono">{headRef}</code>
        </span>
      ) : null}
    </div>
  );
});
