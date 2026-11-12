import React from 'react';
import type { ProjectEntry } from '@/lib/api/types';
import { useRuntimeObjectUrl } from '@/lib/runtimeObjectUrl';
import type { IconName } from "@/components/icon/icons";
import { isHexColor } from '@/lib/colorPresets';

type ThemeVariant = 'light' | 'dark';
type ProjectIconImageOptions = { themeVariant?: ThemeVariant; iconColor?: string };

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
  { key: 'cpu',        Icon: 'cpu',            label: 'Hardware' },
  { key: 'cloud',      Icon: 'cloud',          label: 'Cloud' },
  { key: 'store',      Icon: 'store-2',        label: 'Store' },
  { key: 'school',     Icon: 'graduation-cap', label: 'Study' },
  { key: 'chat',       Icon: 'chat-3',         label: 'Chat' },
  { key: 'mail',       Icon: 'mail',           label: 'Mail' },
  { key: 'map',        Icon: 'map-pin-2',      label: 'Places' },
  { key: 'robot',      Icon: 'robot-2',        label: 'Bot' },
  { key: 'ai',         Icon: 'brain-ai-3',     label: 'AI' },
  { key: 'plugin',     Icon: 'puzzle-2',       label: 'Plugin' },
  { key: 'tools',      Icon: 'tools',          label: 'Tools' },
  { key: 'chart',      Icon: 'bar-chart-box',  label: 'Analytics' },
  { key: 'writing',    Icon: 'pen-nib',        label: 'Writing' },
  { key: 'image',      Icon: 'image-2',        label: 'Images' },
  { key: 'film',       Icon: 'film',           label: 'Video' },
  { key: 'trophy',     Icon: 'trophy',         label: 'Goals' },
  { key: 'travel',     Icon: 'plane',          label: 'Travel' },
  { key: 'coffee',     Icon: 'cup',            label: 'Coffee' },
  { key: 'bug',        Icon: 'bug',            label: 'Bugs' },
  { key: 'apple',      Icon: 'apple',          label: 'Apple' },
  { key: 'android',    Icon: 'android',        label: 'Android' },
  { key: 'windows',    Icon: 'windows',        label: 'Windows' },
  { key: 'github',     Icon: 'github',         label: 'GitHub' },
  { key: 'stack',      Icon: 'stack',          label: 'Stack' },
  { key: 'finance',    Icon: 'bank',           label: 'Finance' },
  { key: 'team',       Icon: 'team',           label: 'Team' },
  { key: 'fire',       Icon: 'fire',           label: 'Hot' },
  { key: 'planet',     Icon: 'planet',         label: 'Space' },
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

const useProjectIconImageObjectUrl = (
  project: Pick<ProjectEntry, 'id' | 'iconImage'>,
  options?: ProjectIconImageOptions,
): string | null => {
  const query = buildProjectIconQuery(project.iconImage?.updatedAt, options);
  const path = query && project.id ? `/api/projects/${encodeURIComponent(project.id)}/icon` : null;
  return useRuntimeObjectUrl(path, query?.toString() ?? '').url;
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
