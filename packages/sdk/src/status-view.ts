// A Work Status section the host draws itself. The extension declares
// `contributes.statusSection.source`; the host asks the extension's service
// for a `GuestStatusView` at that path while the section is on screen and
// draws it with the app's own rows, so the section needs no frame.
// Host-side zod schemas live in `status-view-schemas.ts`.
import type { GuestStatusControl, GuestStatusControlOption } from './status-controls.ts';

/** Fastest the host asks a service for its section, in ms. */
export const GUEST_STATUS_SOURCE_INTERVAL_MIN = 1_000;
/** Slowest polling a source may ask for, in ms. */
export const GUEST_STATUS_SOURCE_INTERVAL_MAX = 60_000;
/** Polling interval when the manifest names none, in ms. */
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

/** Where the host reads a source-backed section and how often. */
export type StatusSectionSource = {
  /** Service path, such as `/status`. */
  path: string;
  /** Milliseconds between reads while the section is on screen. */
  interval?: number;
};

/**
 * Colours come from the theme, never from the extension: `accent` is the
 * theme's primary, the status tones are its status colours, `muted` is
 * secondary text.
 */
export type GuestStatusTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'info';

/** How a chart's hover label formats a point. */
export type GuestStatusChartUnit = 'bytes' | 'percent' | 'count';

export type GuestStatusChip = {
  id: string;
  label: string;
  tone?: GuestStatusTone;
  /** An `http(s)` URL the chip opens; without one the chip is a label. */
  url?: string;
};

/** What sits between a line's label and its value. */
export type GuestStatusContent =
  | { kind: 'bar'; value: number; tone?: GuestStatusTone }
  | {
    kind: 'chart';
    /** Oldest first; the newest point sits at the right edge. */
    values: number[];
    /** Top of the chart; the largest value when omitted. */
    max?: number;
    tone?: GuestStatusTone;
    unit?: GuestStatusChartUnit;
    /** Seconds between points, for the hover's "12 s ago". */
    step?: number;
  }
  | { kind: 'chips'; chips: GuestStatusChip[] }
  | { kind: 'text'; text: string; tone?: GuestStatusTone }
  | { kind: 'segmented'; id: string; label: string; value: string; options: GuestStatusControlOption[]; disabled?: boolean };

/** A control at the end of a line. Activating it posts `{ id, value? }` to the source path. */
export type GuestStatusAction =
  | {
    kind: 'button';
    id: string;
    label: string;
    variant?: 'default' | 'outline' | 'destructive';
    /** Asked on the first click; the second click acts. */
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
    /** A Remixicon name, as in `panel.icon`. */
    icon?: string;
    /** A status dot before the label. */
    dot?: GuestStatusTone;
    content?: GuestStatusContent;
    value?: string;
    valueTone?: GuestStatusTone;
    badge?: { label: string; tone?: GuestStatusTone };
    tooltip?: string;
    actions?: GuestStatusAction[];
  }
  | { kind: 'note'; id: string; text: string; tone?: 'muted' | 'info' | 'warning' | 'error' };

/** The answer to `GET <source.path>`. */
export type GuestStatusView = {
  rows: GuestStatusRow[];
  /** Header controls, the same declarations `setStatusControls` takes. */
  controls?: GuestStatusControl[];
};

/**
 * The body of `POST <source.path>` when the user activates a control. A switch
 * sends `on` or `off`; a select or segmented control sends the chosen value; a
 * button sends no value.
 */
export type GuestStatusActionEvent = {
  id: string;
  value?: string;
};
