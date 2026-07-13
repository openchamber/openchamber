import React from 'react';
import type { ProjectEntry } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import type { IconName } from "@/components/icon/icons";

type ThemeVariant = 'light' | 'dark';
type ProjectIconImageOptions = { themeVariant?: ThemeVariant; iconColor?: string };

const PROJECT_ICON_OBJECT_URL_CACHE_LIMIT = 200;

type ProjectIconObjectUrlCacheEntry = {
  url?: string;
  promise?: Promise<string | null>;
};

type ProjectIconObjectUrlRequest = {
  cacheKey: string;
  projectId: string;
  query: URLSearchParams;
};

const projectIconObjectUrlCache = new Map<string, ProjectIconObjectUrlCacheEntry>();

export const PROJECT_ICONS: Array<{ key: string; Icon: IconName; label: string }> = [
  { key: 'code',       Icon: 'code-box',      label: 'Code' },
  { key: 'terminal',   Icon: 'terminal-box',   label: 'Terminal' },
  { key: 'rocket',     Icon: 'rocket',        label: 'Rocket' },
  { key: 'flask',      Icon: 'flask',         label: 'Lab' },
  { key: 'gamepad',    Icon: 'gamepad',       label: 'Game' },
  { key: 'briefcase',  Icon: 'briefcase',     label: 'Work' },
  { key: 'home',       Icon: 'home',          label: 'Home' },
  { key: 'globe',      Icon: 'global',        label: 'Web' },
  { key: 'leaf',       Icon: 'leaf',          label: 'Nature' },
  { key: 'shield',     Icon: 'shield',        label: 'Security' },
  { key: 'palette',    Icon: 'palette',       label: 'Design' },
  { key: 'server',     Icon: 'server',        label: 'Server' },
  { key: 'phone',      Icon: 'smartphone',    label: 'Mobile' },
  { key: 'database',   Icon: 'database-2',     label: 'Data' },
  { key: 'lightbulb',  Icon: 'lightbulb',     label: 'Idea' },
  { key: 'music',      Icon: 'music',         label: 'Music' },
  { key: 'camera',     Icon: 'camera',        label: 'Media' },
  { key: 'book',       Icon: 'book-open',      label: 'Docs' },
  { key: 'heart',      Icon: 'heart',         label: 'Favorite' },
];

export const PROJECT_ICON_MAP: Record<string, IconName> = Object.fromEntries(
  PROJECT_ICONS.map((i) => [i.key, i.Icon])
);

export const PROJECT_COLORS: Array<{ key: string; label: string; cssVar: string }> = [
  { key: 'keyword',  label: 'Purple',  cssVar: 'var(--syntax-keyword)' },
  { key: 'string',   label: 'Green',   cssVar: 'var(--syntax-string)' },
  { key: 'number',   label: 'Pink',    cssVar: 'var(--syntax-number)' },
  { key: 'type',     label: 'Gold',    cssVar: 'var(--syntax-type)' },
  { key: 'constant', label: 'Cyan',    cssVar: 'var(--syntax-constant)' },
  { key: 'comment',  label: 'Muted',   cssVar: 'var(--syntax-comment)' },
  { key: 'error',    label: 'Red',     cssVar: 'var(--status-error)' },
  { key: 'primary',  label: 'Blue',    cssVar: 'var(--primary)' },
  { key: 'success', label: 'Green', cssVar: 'var(--status-success)' },
];

export const PROJECT_COLOR_MAP: Record<string, string> = Object.fromEntries(
  PROJECT_COLORS.map((c) => [c.key, c.cssVar])
);

const buildProjectIconQuery = (updatedAt: number | null | undefined, options?: ProjectIconImageOptions): URLSearchParams | null => {
  if (typeof updatedAt !== 'number' || updatedAt <= 0) {
    return null;
  }

  const params = new URLSearchParams({ v: String(updatedAt) });
  if (typeof options?.iconColor === 'string' && options.iconColor.trim()) {
    params.set('iconColor', options.iconColor.trim());
  }
  if (options?.themeVariant === 'light' || options?.themeVariant === 'dark') {
    params.set('theme', options.themeVariant);
  }
  return params;
};

const buildProjectIconObjectUrlCacheKey = (
  projectId: string,
  query: URLSearchParams,
): string | null => {
  if (!projectId) return null;
  return [
    getRuntimeApiBaseUrl() || 'same-origin',
    projectId,
    query.toString(),
  ].join('|');
};

const buildProjectIconObjectUrlRequest = (
  projectId: string,
  updatedAt: number | null | undefined,
  options?: ProjectIconImageOptions,
): ProjectIconObjectUrlRequest | null => {
  const query = buildProjectIconQuery(updatedAt, options);
  if (!query) return null;

  const cacheKey = buildProjectIconObjectUrlCacheKey(projectId, query);
  if (!cacheKey) return null;

  return { cacheKey, projectId, query };
};

const trimProjectIconObjectUrlCache = (): void => {
  while (projectIconObjectUrlCache.size > PROJECT_ICON_OBJECT_URL_CACHE_LIMIT) {
    const firstKey = projectIconObjectUrlCache.keys().next().value;
    if (typeof firstKey !== 'string') return;
    const entry = projectIconObjectUrlCache.get(firstKey);
    if (entry?.url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(entry.url);
    }
    projectIconObjectUrlCache.delete(firstKey);
  }
};

const loadProjectIconObjectUrl = (
  request: ProjectIconObjectUrlRequest,
): Promise<string | null> => {
  const cached = projectIconObjectUrlCache.get(request.cacheKey);
  if (cached?.url) return Promise.resolve(cached.url);
  if (cached?.promise) return cached.promise;

  const promise = runtimeFetch(`/api/projects/${encodeURIComponent(request.projectId)}/icon`, {
    method: 'GET',
    headers: { Accept: 'image/*' },
    query: request.query,
  })
    .then(async (response) => {
      if (!response.ok) return null;
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      projectIconObjectUrlCache.set(request.cacheKey, { url });
      trimProjectIconObjectUrlCache();
      return url;
    })
    .catch(() => null)
    .finally(() => {
      const entry = projectIconObjectUrlCache.get(request.cacheKey);
      if (entry?.promise === promise && !entry.url) {
        projectIconObjectUrlCache.delete(request.cacheKey);
      }
    });

  projectIconObjectUrlCache.set(request.cacheKey, { promise });
  return promise;
};

const useProjectIconImageObjectUrl = (
  project: Pick<ProjectEntry, 'id' | 'iconImage'>,
  options?: ProjectIconImageOptions,
): string | null => {
  const projectId = project.id;
  const updatedAt = project.iconImage?.updatedAt;
  const themeVariant = options?.themeVariant;
  const iconColor = options?.iconColor;
  const request = React.useMemo(() => buildProjectIconObjectUrlRequest(projectId, updatedAt, { themeVariant, iconColor }), [
    projectId,
    updatedAt,
    themeVariant,
    iconColor,
  ]);
  const [url, setUrl] = React.useState(() => {
    return request ? projectIconObjectUrlCache.get(request.cacheKey)?.url ?? null : null;
  });

  React.useEffect(() => {
    if (!request) {
      setUrl(null);
      return;
    }

    const cached = projectIconObjectUrlCache.get(request.cacheKey)?.url;
    if (cached) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    setUrl(null);
    void loadProjectIconObjectUrl(request).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [request]);

  return url;
};

export type ProjectIconImageProps = {
  project: Pick<ProjectEntry, 'id' | 'iconImage'>;
  options?: ProjectIconImageOptions;
  className?: string;
  alt?: string;
  draggable?: boolean;
  fallback?: React.ReactNode;
  onError?: React.ReactEventHandler<HTMLImageElement>;
};

export const ProjectIconImage: React.FC<ProjectIconImageProps> = ({
  project,
  options,
  className,
  alt = '',
  draggable = false,
  fallback = null,
  onError,
}) => {
  const src = useProjectIconImageObjectUrl(project, options);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(false);
  }, [src, project.id, project.iconImage?.updatedAt]);

  if (!src || failed) return React.createElement(React.Fragment, null, fallback);

  return React.createElement('img', {
    src,
    alt,
    className,
    draggable,
    onError: (event: React.SyntheticEvent<HTMLImageElement>) => {
      setFailed(true);
      onError?.(event);
    },
  });
};
