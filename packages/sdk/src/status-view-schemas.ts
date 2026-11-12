import { z } from 'zod';

import { guestStatusControlsSchema } from './status-control-schemas.ts';
import {
  GUEST_STATUS_CONTROL_ID,
  GUEST_STATUS_CONTROL_LABEL_MAX,
  GUEST_STATUS_CONTROL_OPTIONS_MAX,
  GUEST_STATUS_CONTROL_VALUE_MAX,
} from './status-controls.ts';
import {
  GUEST_STATUS_VIEW_ACTIONS_MAX,
  GUEST_STATUS_VIEW_CHART_POINTS_MAX,
  GUEST_STATUS_VIEW_CHIPS_MAX,
  GUEST_STATUS_VIEW_ICON,
  GUEST_STATUS_VIEW_NOTE_MAX,
  GUEST_STATUS_VIEW_ROWS_MAX,
  GUEST_STATUS_VIEW_SEGMENTS_MAX,
  GUEST_STATUS_VIEW_SEGMENTS_MIN,
  GUEST_STATUS_VIEW_TEXT_MAX,
  type GuestStatusView,
} from './status-view.ts';

const idSchema = z.string().regex(GUEST_STATUS_CONTROL_ID);
const labelSchema = z.string().min(1).max(GUEST_STATUS_CONTROL_LABEL_MAX);
const valueSchema = z.string().min(1).max(GUEST_STATUS_CONTROL_VALUE_MAX);
const textSchema = z.string().min(1).max(GUEST_STATUS_VIEW_TEXT_MAX);
const toneSchema = z.enum(['default', 'muted', 'accent', 'success', 'warning', 'error', 'info']);
const finite = z.number().finite();

const isWebUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const optionSchema = z.object({ value: valueSchema, label: labelSchema }).strict();

/** One to `max` options with unique values, and `value` among them. */
const choiceSchema = <K extends 'segmented' | 'select'>(kind: K, min: number, max: number) => z.object({
  kind: z.literal(kind),
  id: idSchema,
  label: labelSchema,
  value: valueSchema,
  options: z.array(optionSchema).min(min).max(max),
  disabled: z.boolean().optional(),
}).strict().refine(
  (choice) => new Set(choice.options.map((option) => option.value)).size === choice.options.length,
  { message: 'option values must be unique', path: ['options'] },
).refine(
  (choice) => choice.options.some((option) => option.value === choice.value),
  { message: 'value must be one of its options', path: ['value'] },
);

const chipSchema = z.object({
  id: idSchema,
  label: labelSchema,
  tone: toneSchema.optional(),
  url: z.string().max(2_000).refine(isWebUrl, { message: 'chip url must be http(s)' }).optional(),
}).strict();

const contentSchema = z.union([
  z.object({ kind: z.literal('bar'), value: finite.min(0).max(100), tone: toneSchema.optional() }).strict(),
  z.object({
    kind: z.literal('chart'),
    values: z.array(finite.min(0)).max(GUEST_STATUS_VIEW_CHART_POINTS_MAX),
    max: finite.positive().optional(),
    tone: toneSchema.optional(),
    unit: z.enum(['bytes', 'percent', 'count']).optional(),
    step: finite.positive().max(3_600).optional(),
  }).strict(),
  z.object({
    kind: z.literal('chips'),
    chips: z.array(chipSchema).min(1).max(GUEST_STATUS_VIEW_CHIPS_MAX),
  }).strict(),
  z.object({ kind: z.literal('text'), text: textSchema, tone: toneSchema.optional() }).strict(),
  choiceSchema('segmented', GUEST_STATUS_VIEW_SEGMENTS_MIN, GUEST_STATUS_VIEW_SEGMENTS_MAX),
]);

const actionSchema = z.union([
  z.object({
    kind: z.literal('button'),
    id: idSchema,
    label: labelSchema,
    variant: z.enum(['default', 'outline', 'destructive']).optional(),
    confirm: labelSchema.optional(),
    disabled: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('switch'),
    id: idSchema,
    label: labelSchema,
    checked: z.boolean(),
    disabled: z.boolean().optional(),
  }).strict(),
  choiceSchema('select', 1, GUEST_STATUS_CONTROL_OPTIONS_MAX),
]);

const rowSchema = z.union([
  z.object({
    kind: z.literal('line'),
    id: idSchema,
    label: labelSchema,
    icon: z.string().regex(GUEST_STATUS_VIEW_ICON).optional(),
    dot: toneSchema.optional(),
    content: contentSchema.optional(),
    value: valueSchema.optional(),
    valueTone: toneSchema.optional(),
    badge: z.object({ label: labelSchema, tone: toneSchema.optional() }).strict().optional(),
    tooltip: textSchema.optional(),
    actions: z.array(actionSchema).max(GUEST_STATUS_VIEW_ACTIONS_MAX).optional(),
  }).strict(),
  z.object({
    kind: z.literal('note'),
    id: idSchema,
    text: z.string().min(1).max(GUEST_STATUS_VIEW_NOTE_MAX),
    tone: z.enum(['muted', 'info', 'warning', 'error']).optional(),
  }).strict(),
]);

/** Every id a view's controls answer to: header controls, line actions, segmented choices. */
const controlIds = (view: GuestStatusView): string[] => [
  ...(view.controls ?? []).map((control) => control.id),
  ...view.rows.flatMap((row) => (row.kind === 'line'
    ? [
      ...(row.actions ?? []).map((action) => action.id),
      ...(row.content?.kind === 'segmented' ? [row.content.id] : []),
    ]
    : [])),
];

/** A service's answer to `GET <source.path>`. Row ids and control ids are each unique. */
export const guestStatusViewSchema = z.object({
  rows: z.array(rowSchema).max(GUEST_STATUS_VIEW_ROWS_MAX),
  controls: guestStatusControlsSchema.optional(),
}).strict().refine(
  (view) => new Set(view.rows.map((row) => row.id)).size === view.rows.length,
  { message: 'row ids must be unique', path: ['rows'] },
).refine(
  (view) => {
    const ids = controlIds(view);
    return new Set(ids).size === ids.length;
  },
  { message: 'control ids must be unique across the view' },
);

// The hand-written contract and the schema describe the same answer; either
// drifting from the other fails this file's type-check.
type ParsedStatusView = z.infer<typeof guestStatusViewSchema>;
const assertViewParsed: (value: ParsedStatusView) => GuestStatusView = (value) => value;
const assertViewContract: (value: GuestStatusView) => ParsedStatusView = (value) => value;
void assertViewParsed; void assertViewContract;
