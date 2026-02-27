import {
  RiCodeBoxLine,
  RiTerminalBoxLine,
  RiRocketLine,
  RiFlaskLine,
  RiGamepadLine,
  RiBriefcaseLine,
  RiHomeLine,
  RiGlobalLine,
  RiLeafLine,
  RiShieldLine,
  RiPaletteLine,
  RiServerLine,
  RiSmartphoneLine,
  RiDatabase2Line,
  RiLightbulbLine,
  RiMusicLine,
  RiCameraLine,
  RiBookOpenLine,
  RiHeartLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import type { ProjectEntry } from '@/lib/api/types';

export const PROJECT_ICONS: Array<{ key: string; Icon: RemixiconComponentType; label: string }> = [
  { key: 'code',       Icon: RiCodeBoxLine,      label: 'Code' },
  { key: 'terminal',   Icon: RiTerminalBoxLine,   label: 'Terminal' },
  { key: 'rocket',     Icon: RiRocketLine,        label: 'Rocket' },
  { key: 'flask',      Icon: RiFlaskLine,         label: 'Lab' },
  { key: 'gamepad',    Icon: RiGamepadLine,       label: 'Game' },
  { key: 'briefcase',  Icon: RiBriefcaseLine,     label: 'Work' },
  { key: 'home',       Icon: RiHomeLine,          label: 'Home' },
  { key: 'globe',      Icon: RiGlobalLine,        label: 'Web' },
  { key: 'leaf',       Icon: RiLeafLine,          label: 'Nature' },
  { key: 'shield',     Icon: RiShieldLine,        label: 'Security' },
  { key: 'palette',    Icon: RiPaletteLine,       label: 'Design' },
  { key: 'server',     Icon: RiServerLine,        label: 'Server' },
  { key: 'phone',      Icon: RiSmartphoneLine,    label: 'Mobile' },
  { key: 'database',   Icon: RiDatabase2Line,     label: 'Data' },
  { key: 'lightbulb',  Icon: RiLightbulbLine,     label: 'Idea' },
  { key: 'music',      Icon: RiMusicLine,         label: 'Music' },
  { key: 'camera',     Icon: RiCameraLine,        label: 'Media' },
  { key: 'book',       Icon: RiBookOpenLine,      label: 'Docs' },
  { key: 'heart',      Icon: RiHeartLine,         label: 'Favorite' },
];

export const PROJECT_ICON_MAP: Record<string, RemixiconComponentType> = Object.fromEntries(
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

export const getProjectIconImageUrl = (project: Pick<ProjectEntry, 'id' | 'iconImage'>): string | null => {
  if (!project.iconImage || typeof project.iconImage.updatedAt !== 'number' || project.iconImage.updatedAt <= 0) {
    return null;
  }

  return `/api/projects/${encodeURIComponent(project.id)}/icon?v=${project.iconImage.updatedAt}`;
};
