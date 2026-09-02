import type { ProjectEntry } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { formatDirectoryName } from '@/lib/utils';

const SESSION_ID_LABEL_PATTERN = /^(?:ses[_-]|session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PREFIX_PATTERN = /^ses[_-]/i;
const CONTEXT_SEPARATOR = ' · ';

export const isSessionIdentityLabel = (value: string | undefined): boolean => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return false;
  return SESSION_ID_PREFIX_PATTERN.test(trimmed) || SESSION_ID_LABEL_PATTERN.test(trimmed);
};

export const usableSessionNotificationTitle = (
  title: string | undefined,
  sessionId: string | undefined,
): string | undefined => {
  const trimmed = title?.trim() ?? '';
  if (!trimmed) return undefined;
  if (sessionId && trimmed === sessionId) return undefined;
  if (isSessionIdentityLabel(trimmed)) return undefined;
  return trimmed;
};

const usableProjectLabel = (label: string | undefined): string | undefined => {
  const trimmed = label?.trim() ?? '';
  if (!trimmed || isSessionIdentityLabel(trimmed)) return undefined;
  return trimmed;
};

export const displaySessionNotificationBody = (
  body: string,
  sessionId: string | undefined,
  liveTitle: string | undefined,
  untitled: string,
): string => {
  const lines = body.split('\n');
  const first = lines[0] ?? '';
  const separatorIndex = first.indexOf(CONTEXT_SEPARATOR);
  const name = separatorIndex >= 0 ? first.slice(0, separatorIndex) : first;
  const project = separatorIndex >= 0 ? first.slice(separatorIndex + CONTEXT_SEPARATOR.length) : '';
  const live = usableSessionNotificationTitle(liveTitle, sessionId);
  const stored = usableSessionNotificationTitle(name, sessionId);
  const nextName = live ?? stored ?? untitled;
  const nextProject = usableProjectLabel(project);
  const nextFirst = nextProject ? `${nextName} · ${nextProject}` : nextName;
  if (nextFirst === first) return body;
  return [nextFirst, ...lines.slice(1)].join('\n');
};

export const resolveNotificationProjectLabel = (
  directory: string | undefined,
  projects: readonly ProjectEntry[],
): string => {
  if (!directory) return '';
  const normalized = normalizePath(directory);
  if (!normalized) return formatDirectoryName(directory);

  let prefixMatch: ProjectEntry | null = null;
  let prefixLength = 0;
  for (const project of projects) {
    const projectPath = normalizePath(project.path);
    if (!projectPath) continue;
    if (projectPath === normalized) {
      return usableProjectLabel(project.label) || usableProjectLabel(formatDirectoryName(project.path)) || '';
    }
    if (normalized.startsWith(`${projectPath}/`) && projectPath.length > prefixLength) {
      prefixMatch = project;
      prefixLength = projectPath.length;
    }
  }
  if (prefixMatch) {
    return usableProjectLabel(prefixMatch.label) || formatDirectoryName(prefixMatch.path);
  }
  return usableProjectLabel(formatDirectoryName(directory)) ?? '';
};
