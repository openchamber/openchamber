import type { ProjectEntry } from '@/lib/api/types';
import type { IconName } from "@/components/icon/icons";

type ThemeVariant = 'light' | 'dark';

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

export const getProjectIconImageUrl = (
  project: Pick<ProjectEntry, 'id' | 'iconImage'>,
  options?: { themeVariant?: ThemeVariant; iconColor?: string },
): string | null => {
  if (!project.iconImage || typeof project.iconImage.updatedAt !== 'number' || project.iconImage.updatedAt <= 0) {
    return null;
  }

  const params = new URLSearchParams({ v: String(project.iconImage.updatedAt) });
  if (typeof options?.iconColor === 'string' && options.iconColor.trim()) {
    params.set('iconColor', options.iconColor.trim());
  }
  if (options?.themeVariant === 'light' || options?.themeVariant === 'dark') {
    params.set('theme', options.themeVariant);
  }

  return `/api/projects/${encodeURIComponent(project.id)}/icon?${params.toString()}`;
};
