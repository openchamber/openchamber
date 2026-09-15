import type { GitHistoryItem, GitLogEntry } from '@/lib/api/types';

export type GitCommitHoverModel = {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  relativeTime: string;
  statistics: {
    files: number;
    insertions: number;
    deletions: number;
  };
};

type RelativeTimeOptions = {
  locale: string;
  now?: () => number;
};

const isGitHistoryItem = (entry: GitLogEntry | GitHistoryItem): entry is GitHistoryItem => 'subject' in entry;

const stripSubjectFromMessage = (subject: string, message: string): string => {
  if (!message.startsWith(subject)) {
    return message.trim();
  }

  return message.slice(subject.length).replace(/^\s+/, '').trim();
};

const relativeTimeUnits: Array<{ unit: Intl.RelativeTimeFormatUnit; milliseconds: number }> = [
  { unit: 'year', milliseconds: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', milliseconds: 24 * 60 * 60 * 1000 },
  { unit: 'hour', milliseconds: 60 * 60 * 1000 },
  { unit: 'minute', milliseconds: 60 * 1000 },
  { unit: 'second', milliseconds: 1000 },
];

export function formatGitCommitHoverRelativeTime(timestamp: string, options: RelativeTimeOptions): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }

  const now = options.now?.() ?? Date.now();
  const delta = parsed - now;
  const formatter = new Intl.RelativeTimeFormat(options.locale, { numeric: 'auto' });

  for (const { unit, milliseconds } of relativeTimeUnits) {
    if (Math.abs(delta) >= milliseconds || unit === 'second') {
      return formatter.format(Math.round(delta / milliseconds), unit);
    }
  }

  return timestamp;
}

export function normalizeGitCommitHoverEntry(entry: GitLogEntry | GitHistoryItem): GitCommitHoverModel {
  if (isGitHistoryItem(entry)) {
    return {
      hash: entry.id,
      shortHash: entry.id.slice(0, 7),
      subject: entry.subject,
      body: stripSubjectFromMessage(entry.subject, entry.message),
      authorName: entry.author,
      authorEmail: entry.authorEmail,
      timestamp: entry.timestamp,
      relativeTime: entry.timestamp,
      statistics: entry.statistics,
    };
  }

  return {
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 7),
    subject: entry.message,
    body: entry.body.trim(),
    authorName: entry.author_name,
    authorEmail: entry.author_email,
    timestamp: entry.date,
    relativeTime: entry.date,
    statistics: {
      files: entry.filesChanged,
      insertions: entry.insertions,
      deletions: entry.deletions,
    },
  };
}
