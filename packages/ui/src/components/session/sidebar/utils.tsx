import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { matchSegments, type MatchRange } from '@/lib/search/matchSegments';
import { MatchHighlight } from '@/components/ui/MatchHighlight';

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
    return t('common.relative.minutesAgoCompact', { count: Math.max(1, Math.floor(diff / minute)) });
  }
  if (diff < day) {
    return t('common.relative.hoursAgoCompact', { count: Math.floor(diff / hour) });
  }
  if (diff < week) {
    return t('common.relative.daysAgoCompact', { count: Math.floor(diff / day) });
  }
  if (diff < 5 * week) {
    return t('common.relative.weeksAgoCompact', { count: Math.floor(diff / week) });
  }
  if (diff < year) {
    return t('common.relative.monthsAgoCompact', { count: Math.floor(diff / month) });
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
  const prefix = normalizedProjectPath.endsWith('/') ? normalizedProjectPath : `${normalizedProjectPath}/`;
  return normalizedDirectory.startsWith(prefix);
};

const normalizeForBranchComparison = (value: string): string => {
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

/**
 * A worktree group is named after its branch as it is now. A listing names a
 * worktree by the branch it had then, or by its folder when it had none (a
 * worktree created detached, given a branch later); either follows the live
 * branch. Only a label that names something else is kept.
 */
export const resolveWorktreeGroupLabel = (
  meta: { label?: string | null; name?: string | null; branch?: string | null },
  currentBranch: string | null,
  fallback: string,
): string => {
  const label = meta.label || meta.name || fallback;
  if (!currentBranch) return label;
  const listedBranch = meta.branch?.trim() || null;
  const labelIsBranch = listedBranch
    ? Boolean(meta.label) && normalizeForBranchComparison(meta.label ?? '') === normalizeForBranchComparison(listedBranch)
    : true;
  return labelIsBranch ? currentBranch : label;
};

export const dedupeSessionsById = (sessions: Session[]): Session[] => {
  const byId = new Map<string, Session>();
  sessions.forEach((session) => {
    byId.set(session.id, session);
  });
  return Array.from(byId.values());
};

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

// Folder names are shown exactly as they are on disk — no title-casing.
export const formatProjectLabel = (label: string): string => label.trim();

// The sidebar's filter marks every occurrence of the query.
export const renderHighlightedText = (text: string, query: string): React.ReactNode => {
  if (!query) {
    return text;
  }

  const loweredText = text.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const ranges: MatchRange[] = [];
  let matchIndex = loweredText.indexOf(loweredQuery);
  while (matchIndex !== -1) {
    ranges.push([matchIndex, matchIndex + loweredQuery.length]);
    matchIndex = loweredText.indexOf(loweredQuery, matchIndex + loweredQuery.length);
  }
  if (ranges.length === 0) {
    return text;
  }

  return <MatchHighlight segments={matchSegments(text, ranges)} />;
};
