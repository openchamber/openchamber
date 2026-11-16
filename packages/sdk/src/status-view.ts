import type { GuestStatusControl, GuestStatusControlOption } from './status-controls.ts';

export const GUEST_STATUS_SOURCE_INTERVAL_MIN = 1_000;
export const GUEST_STATUS_SOURCE_INTERVAL_MAX = 60_000;
export const GUEST_STATUS_SOURCE_INTERVAL_DEFAULT = 2_000;

export const GUEST_STATUS_VIEW_ROWS_MAX = 16;
export const GUEST_STATUS_VIEW_ACTIONS_MAX = 2;
export const GUEST_STATUS_VIEW_CHIPS_MAX = 6;
export const GUEST_STATUS_VIEW_CHART_POINTS_MAX = 120;
export const GUEST_STATUS_VIEW_SEGMENTS_MIN = 2;
export const GUEST_STATUS_VIEW_SEGMENTS_MAX = 4;
export const GUEST_STATUS_VIEW_TEXT_MAX = 200;
export const GUEST_STATUS_VIEW_NOTE_MAX = 300;
export const GUEST_STATUS_VIEW_ICON = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type StatusSectionSource = {
  path: string;
  interval?: number;
};

export type GuestStatusTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'info';

export type GuestStatusChartUnit = 'bytes' | 'percent' | 'count';

export type GuestStatusChip = {
  id: string;
  label: string;
  tone?: GuestStatusTone;
  url?: string;
};

export type GuestStatusContent =
  | { kind: 'bar'; value: number; tone?: GuestStatusTone }
  | {
    kind: 'chart';
    values: number[];
    max?: number;
    tone?: GuestStatusTone;
    unit?: GuestStatusChartUnit;
    step?: number;
  }
  | { kind: 'chips'; chips: GuestStatusChip[] }
  | { kind: 'text'; text: string; tone?: GuestStatusTone }
  | { kind: 'segmented'; id: string; label: string; value: string; options: GuestStatusControlOption[]; disabled?: boolean };

export type GuestStatusAction =
  | {
    kind: 'button';
    id: string;
    label: string;
    variant?: 'default' | 'outline' | 'destructive';
    confirm?: string;
    disabled?: boolean;
  }
  | { kind: 'switch'; id: string; label: string; checked: boolean; disabled?: boolean }
  | { kind: 'select'; id: string; label: string; value: string; options: GuestStatusControlOption[]; disabled?: boolean };

export type GuestStatusRow =
  | {
    kind: 'line';
    id: string;
    label: string;
    icon?: string;
    dot?: GuestStatusTone;
    content?: GuestStatusContent;
    value?: string;
    valueTone?: GuestStatusTone;
    badge?: { label: string; tone?: GuestStatusTone };
    tooltip?: string;
    actions?: GuestStatusAction[];
  }
  | { kind: 'note'; id: string; text: string; tone?: 'muted' | 'info' | 'warning' | 'error' };

export type GuestStatusView = {
  rows: GuestStatusRow[];
  controls?: GuestStatusControl[];
};

export type GuestStatusActionEvent = {
  id: string;
  value?: string;
};
