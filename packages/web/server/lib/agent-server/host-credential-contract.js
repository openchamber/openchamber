import path from 'node:path';
import { z } from 'zod';
import { providerIdSchema } from '../spaces/space-records.js';

export const HOST_CREDENTIAL_ROUTE = '/api/openchamber/host-credentials';
export const MAX_HOST_CREDENTIAL_BYTES = 256 * 1024;
const directorySchema = z.string().min(1).max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes('\0'));

// Runtime configuration and control credentials cannot be used as model keys.
const INTERNAL_PREFIX = /^(?:OPENCHAMBER_|OPENCODE_|HERMES_OC_|NODE_|NPM_|npm_|XDG_|SSH_|GIT_|DOCKER_|SYSTEMD_|INVOCATION_)/i;
const INTERNAL_NAMES = new Set(['UI_PASSWORD', 'CREDENTIALS_DIRECTORY', 'NOTIFY_SOCKET', 'LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES']);
export const secretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/)
  .refine((name) => !INTERNAL_PREFIX.test(name) && !INTERNAL_NAMES.has(name.toUpperCase()));
export const secretReplySchema = z.object({ value: z.string().max(8192).nullable() });

const field = z.string().max(8192);
const property = z.string().max(256).refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key));
const jsonValue = (depth) => z.union([
  field, z.number().finite(), z.boolean(), z.null(),
  ...(depth > 0 ? [z.array(jsonValue(depth - 1)).max(256), z.record(property, jsonValue(depth - 1)).refine((value) => Object.keys(value).length <= 256)] : []),
]);
const credentialMetadataSchema = z.record(property, jsonValue(2)).refine((value) => Object.keys(value).length <= 64);
const credentialValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), key: field, metadata: credentialMetadataSchema.optional() }),
  z.object({ type: z.literal('oauth'), methodID: z.string().min(1).max(256), access: field, refresh: field,
    expires: z.number().int().nonnegative(), metadata: credentialMetadataSchema.optional() }),
  z.object({ type: z.literal('external'), methodID: z.string().min(1).max(256), metadata: credentialMetadataSchema.optional() }),
]);
export const credentialSchema = z.object({
  id: z.string().min(1).max(256), integrationID: property.min(1),
  label: z.string().max(256), active: z.boolean(), value: credentialValue,
});
export const credentialsSchema = z.array(credentialSchema).max(256).refine((rows) => {
  const active = rows.filter((row) => row.active).map((row) => row.integrationID);
  return new Set(active).size === active.length;
});
export const emptyQuerySchema = z.object({}).strict();
export const renewedLoginSchema = z.object({
  integrationID: z.enum(['openai', 'github-copilot']), label: z.string().max(256),
  activate: z.literal(true), value: credentialValue.options[1],
}).strict();
const definition = z.object({
  id: providerIdSchema,
  name: z.string().max(256),
  package: z.string().min(1).max(256),
  baseURL: z.string().max(4096).nullable(),
});
export const providerReplySchema = definition.extend({
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/), field.refine((value) => !/[\r\n\0]/.test(value)))
    .refine((value) => Object.keys(value).length <= 32),
  models: z.record(property, jsonValue(4)).refine((value) => Object.keys(value).length <= 256),
  key: z.string().min(1).max(8192).nullable(),
}).nullable();
export const providerListSchema = z.array(definition.extend({
  loopback: z.boolean(), models: z.array(z.string().max(256)).max(256), hasKey: z.boolean(), supported: z.boolean(),
})).max(256);

export const providerQuerySchema = z.object({ directory: directorySchema, provider: providerIdSchema }).strict();
export const listQuerySchema = z.object({ directory: directorySchema }).strict();
export const secretQuerySchema = z.object({ name: secretNameSchema }).strict();
