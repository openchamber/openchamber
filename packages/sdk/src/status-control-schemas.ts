import { z } from 'zod';

import {
  GUEST_STATUS_CONTROL_ID,
  GUEST_STATUS_CONTROL_LABEL_MAX,
  GUEST_STATUS_CONTROL_OPTIONS_MAX,
  GUEST_STATUS_CONTROL_VALUE_MAX,
  GUEST_STATUS_CONTROLS_MAX,
} from './status-controls.ts';

const idSchema = z.string().regex(GUEST_STATUS_CONTROL_ID);
const labelSchema = z.string().min(1).max(GUEST_STATUS_CONTROL_LABEL_MAX);
const optionSchema = z.object({
  value: z.string().min(1).max(GUEST_STATUS_CONTROL_VALUE_MAX),
  label: labelSchema,
}).strict();

const buttonSchema = z.object({
  kind: z.literal('button'),
  id: idSchema,
  label: labelSchema,
  disabled: z.boolean().optional(),
}).strict();

const selectSchema = z.object({
  kind: z.literal('select'),
  id: idSchema,
  label: labelSchema,
  value: z.string().min(1).max(GUEST_STATUS_CONTROL_VALUE_MAX),
  options: z.array(optionSchema).min(1).max(GUEST_STATUS_CONTROL_OPTIONS_MAX),
  disabled: z.boolean().optional(),
}).strict().refine(
  (control) => new Set(control.options.map((option) => option.value)).size === control.options.length,
  { message: 'status control option values must be unique', path: ['options'] },
).refine(
  (control) => control.options.some((option) => option.value === control.value),
  { message: 'status control value must be one of its options', path: ['value'] },
);

export const guestStatusControlsSchema = z.array(z.discriminatedUnion('kind', [buttonSchema, selectSchema]))
  .max(GUEST_STATUS_CONTROLS_MAX)
  .refine(
    (controls) => new Set(controls.map((control) => control.id)).size === controls.length,
    { message: 'status control ids must be unique' },
  );

export const guestStatusControlEventSchema = z.object({
  id: idSchema,
  value: z.string().min(1).max(GUEST_STATUS_CONTROL_VALUE_MAX).optional(),
}).strict();
