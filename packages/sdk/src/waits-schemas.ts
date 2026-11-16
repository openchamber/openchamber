import { z } from 'zod';

import type { JsonValue } from './contract.ts';
import {
  GUEST_WAIT_ARG_STRING_MAX,
  WAIT_ERROR_MAX,
  WAIT_LABEL_MAX,
  WAIT_STATE_MAX,
  WAIT_SUMMARY_MAX,
  type GuestWaitCheckOutcome,
  type GuestWaitCheckResult,
  type GuestWaitParam,
  type GuestWaitStartResult,
} from './waits.ts';

type WaitArgSchema = z.ZodType<string | number | boolean | undefined>;

const waitArgSchema = (name: string, param: GuestWaitParam): WaitArgSchema => {
  const required = `Argument "${name}" is required`;
  const mistyped = `Argument "${name}" must be a ${param.type}`;
  const error: z.core.$ZodErrorMap = (issue) => (issue.input === undefined ? required : mistyped);
  const schema = param.type === 'string'
    ? z.string({ error }).max(GUEST_WAIT_ARG_STRING_MAX, { error: `Argument "${name}" is longer than ${GUEST_WAIT_ARG_STRING_MAX} characters` })
    : param.type === 'number' ? z.number({ error }) : z.boolean({ error });
  return param.required ? schema : schema.optional();
};

export const waitArgsSchema = (params: Readonly<Record<string, GuestWaitParam>> = {}) => {
  const names = Object.keys(params);
  const shape: Record<string, WaitArgSchema> = {};
  for (const [name, param] of Object.entries(params)) shape[name] = waitArgSchema(name, param);
  return z.strictObject(shape, {
    error: (issue) => (issue.code === 'unrecognized_keys'
      ? `Unknown argument "${issue.keys[0]}"; this wait takes ${names.length > 0 ? names.join(', ') : 'none'}`
      : 'args must be an object'),
  });
};

const stateSchema = z.custom<JsonValue>((value) => value !== undefined && JSON.stringify(value).length <= WAIT_STATE_MAX);

export const waitStartResultSchema = z.union([
  z.object({ ok: z.literal(true), state: stateSchema.optional(), label: z.string().trim().min(1).max(WAIT_LABEL_MAX).optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(WAIT_ERROR_MAX) }).strict(),
]);

export const waitCheckResultSchema = z.object({ results: z.array(z.json()) }).strict();

export const waitCheckOutcomeSchema = z.union([
  z.object({ id: z.string().min(1), fired: z.literal(false), state: stateSchema.optional() }).strict(),
  z.object({ id: z.string().min(1), fired: z.literal(true), summary: z.string().trim().min(1).max(WAIT_SUMMARY_MAX) }).strict(),
]);

type ParsedStart = z.output<typeof waitStartResultSchema>;
type ParsedOutcome = z.output<typeof waitCheckOutcomeSchema>;
const assertStartParsed: (value: ParsedStart) => GuestWaitStartResult = (value) => value;
const assertStartContract: (value: GuestWaitStartResult) => ParsedStart = (value) => value;
const assertOutcomeParsed: (value: ParsedOutcome) => GuestWaitCheckOutcome = (value) => value;
const assertOutcomeContract: (value: GuestWaitCheckOutcome) => ParsedOutcome = (value) => value;
const assertCheckContract: (value: GuestWaitCheckResult) => z.input<typeof waitCheckResultSchema> = (value) => value;
void assertStartParsed; void assertStartContract; void assertOutcomeParsed; void assertOutcomeContract; void assertCheckContract;
