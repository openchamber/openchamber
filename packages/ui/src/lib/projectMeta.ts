import React from 'react';
import type { ProjectEntry } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import type { IconName } from "@/components/icon/icons";
import { isHexColor } from '@/lib/colorPresets';

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

/**
 * Colours older builds stored as theme keys, before projects took hex like
 * agents do. Projects saved then still carry the key, so it keeps painting
 * with its theme variable until the user picks a new colour.
 */
const LEGACY_PROJECT_COLORS = new Map<string, string>([
  ['keyword', 'var(--syntax-keyword)'],
  ['string', 'var(--syntax-string)'],
  ['number', 'var(--syntax-number)'],
  ['type', 'var(--syntax-type)'],
  ['constant', 'var(--syntax-constant)'],
  ['comment', 'var(--syntax-comment)'],
  ['error', 'var(--status-error)'],
  ['primary', 'var(--primary)'],
  ['success', 'var(--status-success)'],
]);

/** The CSS colour a project's stored `color` paints with, or null for none or an unknown value. */
export const resolveProjectColor = (color: string | null | undefined): string | null => {
  if (!color) return null;
  if (isHexColor(color)) return color;
  return LEGACY_PROJECT_COLORS.get(color) ?? null;
};

/**
 * The background an image icon gets for a project colour: the colour itself.
 * A legacy theme key has no hex, and the stored background accepts only hex.
 */
export const iconBackgroundForProjectColor = (color: string | null): string | null => (
  color && isHexColor(color) ? color.toLowerCase() : null
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

type ProjectIconImageProps = {
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
