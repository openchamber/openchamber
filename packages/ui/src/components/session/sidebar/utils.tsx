import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';

import { normalizePath } from '@/lib/pathNormalization';
export { normalizePath };

export const selectExpandedParentKeysForContext = (
  previous: Set<string>,
  expanded: ReadonlySet<string>,
  context: 'project' | 'recent',
): Set<string> => {
  const prefix = `${context}:`;
  const next = new Set([...expanded].filter((key) => key.startsWith(prefix)));
  if (previous.size === next.size && [...next].every((key) => previous.has(key))) {
    return previous;
  }
  return next;
};

export const toggleExpandedParentKey = (
  expanded: Set<string>,
  key: string,
): Set<string> => {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

const formatDateLabel = (value: string | number) => {
  const targetDate = new Date(value);
  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(targetDate, today)) {
    return t('common.date.today');
  }
  if (isSameDay(targetDate, yesterday)) {
    return t('common.date.yesterday');
  }
  const formatted = targetDate.toLocaleDateString(getCurrentIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return formatted.replace(',', '');
};

export const formatSessionDateLabel = (updatedMs: number): string => {
  const today = new Date();
  const updatedDate = new Date(updatedMs);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(updatedDate, today)) {
    const diff = Date.now() - updatedMs;
    if (diff < 60_000) return t('common.relative.justNow');
    if (diff < 3_600_000) return t('common.relative.minutesAgoShort', { count: Math.floor(diff / 60_000) });
    return t('common.relative.hoursAgoShort', { count: Math.floor(diff / 3_600_000) });
  }

  return formatDateLabel(updatedMs);
};

export const formatSessionCompactDateLabel = (updatedMs: number): string => {
  const diff = Math.max(0, Date.now() - updatedMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < hour) {
    return `${Math.max(1, Math.floor(diff / minute))}m`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h`;
  }
  if (diff < week) {
    return t('common.relative.daysAgoCompact', { count: Math.floor(diff / day) });
  }
  if (diff < 5 * week) {
    return t('common.relative.weeksAgoCompact', { count: Math.floor(diff / week) });
  }
  if (diff < year) {
    return `${Math.floor(diff / month)}mo`;
  }
  return t('common.relative.yearsAgoCompact', { count: Math.floor(diff / year) });
};

export const isPathWithinProject = (directory?: string | null, projectPath?: string | null): boolean => {
  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectPath = normalizePath(projectPath);
  return isNormalizedPathWithinProject(normalizedDirectory, normalizedProjectPath);
};

const isNormalizedPathWithinProject = (normalizedDirectory: string | null, normalizedProjectPath: string | null): boolean => {
  if (!normalizedDirectory || !normalizedProjectPath) return false;
  if (normalizedDirectory === normalizedProjectPath) return true;
  if (normalizedProjectPath === '/') return normalizedDirectory.startsWith('/');
  return normalizedDirectory.startsWith(`${normalizedProjectPath}/`);
};

export const normalizeForBranchComparison = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/^opencode[/-]?/i, '')
    .replace(/[-_]/g, '')
    .trim();
};

export const isBranchDifferentFromLabel = (branch: string | null, label: string): boolean => {
  if (!branch) return false;
  return normalizeForBranchComparison(branch) !== normalizeForBranchComparison(label);
};

export const dedupeSessionsById = (sessions: Session[]): Session[] => {
  const byId = new Map<string, Session>();
  sessions.forEach((session) => {
    byId.set(session.id, session);
  });
  return Array.from(byId.values());
};

export const getArchivedScopeKey = (projectRoot: string): string => `__archived__:${projectRoot}`;

export const resolveArchivedFolderName = (session: Session, projectRoot: string | null): string => {
  const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
  const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
  const resolved = sessionDirectory ?? projectWorktree;
  if (!resolved) {
    return 'unassigned';
  }
  if (projectRoot && resolved === projectRoot) {
    return 'project root';
  }
  const source = projectRoot && resolved.startsWith(`${projectRoot}/`)
    ? resolved.slice(projectRoot.length + 1)
    : resolved;
  const segments = source.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unassigned';
};

export const formatProjectLabel = (label: string): string => {
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

export const renderHighlightedText = (text: string, query: string): React.ReactNode => {
  if (!query) {
    return text;
  }

  const loweredText = text.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const queryLength = loweredQuery.length;
  if (queryLength === 0) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = loweredText.indexOf(loweredQuery, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const matchText = text.slice(matchIndex, matchIndex + queryLength);
    parts.push(
      <mark
        key={`${matchIndex}-${matchText}`}
        className="bg-primary text-primary-foreground ring-1 ring-primary/90"
      >
        {matchText}
      </mark>,
    );
    cursor = matchIndex + queryLength;
    matchIndex = loweredText.indexOf(loweredQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length > 0 ? parts : text;
};
