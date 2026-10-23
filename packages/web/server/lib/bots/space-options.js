import { z } from 'zod';
import { grantSchema, networkSchema, providerIdSchema, secretSourceSchema } from '../spaces/space-records.js';
import { BotServiceError } from './services/contracts.js';

// The window may target a user-authorized private API. Credentials belong only
// to the named host source, never URL userinfo, query parameters or fragments.
const modelLocation = grantSchema.options[0].pick({ upstream: true });
const modelEndpoint = z.string().max(2_000)
  .refine((value) => modelLocation.safeParse({ upstream: value }).success, 'http or https')
  .pipe(z.string().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
}, 'Model API URLs cannot contain credentials, query parameters or fragments'));

export const botSpaceSchema = z.object({
  placeId: providerIdSchema.optional(),
  network: networkSchema.strict().prefault({ mode: 'allowlist' }),
  grants: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('login'), provider: providerIdSchema }).strict(),
    z.object({ kind: z.literal('custom'), provider: providerIdSchema }).strict(),
    z.object({ kind: z.literal('model'), provider: providerIdSchema, upstream: modelEndpoint, secret: secretSourceSchema.options[0] }).strict(),
  ])).max(16).default([]),
}).strict().refine((value) => new Set(value.grants.map((grant) => grant.provider)).size === value.grants.length,
  'Select one access source per provider');

/** Pure host projection. Missing explicit access must never trigger inheritance. */
export function readBotSpaceOptions(raw, selection) {
  const options = botSpaceSchema.parse(raw === undefined ? {} : raw);
  const grant = options.grants.find((candidate) => candidate.provider === selection.providerID);
  if (!grant) throw new BotServiceError('BOT_ISOLATED_MODEL_GRANT_REQUIRED', 'Select model access for this bot before running it in an isolated space.');
  const resolved = { network: options.network, setupCommands: [], grants: [grant] };
  if (options.placeId) resolved.placeId = options.placeId;
  return resolved;
}
