// What the host remembers about a space beside the runtime's labels: the network choice the user
// made, so the host can say it again to a gatekeeper that starts with an empty memory, and where
// the code went in, so the history and the result find the same repository later.
//
// The labels stay the source of truth about which spaces exist: a record without a space is
// forgotten, and a space without a record is listed with nothing known about it. No secret is
// ever in a record; the design keeps secret values out of the host's disk.

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { requireSpaceId } from './labels.js';
import { MAX_KEPT_OUTPUT_CHARACTERS, MAX_SETUP_COMMAND_LENGTH, MAX_SETUP_COMMANDS } from './space-setup.js';

const RECORDS_DIRECTORY = path.join('spaces', 'records');

const NETWORK_MODES = Object.freeze(['allowlist', 'open']);
// The allowlist's own rule for a name: labels of letters, digits and hyphens, with a real last label.
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const MAX_DOMAINS = 200;

/** One name of an allowlist. */
export const domainSchema = z.string().regex(DOMAIN_PATTERN);

export const networkSchema = z.object({
  mode: z.enum(NETWORK_MODES),
  domains: z.array(domainSchema).max(MAX_DOMAINS).default([]),
});

const historySchema = z.enum(['pending', 'sent', 'already_complete', 'host_shallow', 'failed']);

const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
// zod runs the refinement even when `.url()` failed, so the parse of the URL must not throw here.
const isHttpUrl = (value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};
const upstreamSchema = z.string().url().refine(isHttpUrl, 'http or https');
/** Where the host finds a secret again, never the secret: an environment variable of the host's by name, or the user typed it once. */
export const secretSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/) }).strict(),
  z.object({ kind: z.literal('typed') }).strict(),
]);
/**
 * A grant as the host remembers it. Strict, so a value under any name is refused rather than
 * written: a record holds where a secret comes from and never what it is (decision 5).
 */
export const grantSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    id: z.string().regex(GRANT_ID_PATTERN),
    provider: z.string().regex(GRANT_ID_PATTERN),
    upstream: upstreamSchema,
    header: z.string().regex(/^[a-z0-9-]{1,64}$/),
    source: secretSourceSchema,
  }).strict(),
  z.object({
    kind: z.literal('domain'),
    id: z.string().regex(GRANT_ID_PATTERN),
    upstream: upstreamSchema,
  }).strict(),
]);
const MAX_GRANTS = 100;

// The setup commands' last run (5d-4): begun, finished, or failed with the end of its output,
// which came from inside the space and is text to show. `space-setup.js` keeps it within these.
const setupCountSchema = z.number().int().min(1).max(MAX_SETUP_COMMANDS);
const setupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), total: setupCountSchema, startedAt: z.string() }).strict(),
  z.object({ state: z.literal('done'), total: setupCountSchema, finishedAt: z.string() }).strict(),
  z.object({
    state: z.literal('failed'),
    total: setupCountSchema,
    index: z.number().int().min(0).max(MAX_SETUP_COMMANDS - 1),
    command: z.string().max(MAX_SETUP_COMMAND_LENGTH),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    output: z.string().max(MAX_KEPT_OUTPUT_CHARACTERS),
    finishedAt: z.string(),
  }).strict(),
]);

const recordSchema = z.object({
  version: z.literal(1),
  network: networkSchema,
  /** The host repository the code came from, as the user's project names it. */
  repository: z.string().min(1).nullable().default(null),
  /** The project path inside the space that code in returned. */
  spacePath: z.string().min(1).nullable().default(null),
  /** The commit the snapshot was taken from, which the history is sent behind. */
  base: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable().default(null),
  history: historySchema.default('pending'),
  /** The grants the user gave, said again to the gatekeeper after every start. */
  grants: z.array(grantSchema).max(MAX_GRANTS).default([]),
  /** The setup commands' last run, or null before any. */
  setup: setupSchema.nullable().default(null),
});

/**
 * Per-space records under the host's data directory, one JSON file each, readable by the user only.
 * A record that cannot be read as one is reported as `null` with a warning, never as a fresh one:
 * a bad file must not make the host forget a network choice and leave a space more open than asked.
 */
export function createSpaceRecords({ dataDir, logger = console }) {
  const directory = path.join(dataDir, RECORDS_DIRECTORY);
  const fileOf = (spaceId) => path.join(directory, `${requireSpaceId(spaceId)}.json`);

  /**
   * One grant the host cannot read, from a later version that knows another kind among the
   * reasons, is dropped with a warning and never takes the network, the repository and the
   * history of the record with it: the space then shows that grant as missing, not as unknown.
   */
  const withReadableGrants = (spaceId, raw) => {
    if (!(raw instanceof Object) || !Array.isArray(raw.grants)) return raw;
    const grants = raw.grants.filter((grant) => grantSchema.safeParse(grant).success);
    if (grants.length < raw.grants.length) {
      logger.warn?.(`[spaces] the record of space ${spaceId} holds ${raw.grants.length - grants.length} grant(s) this host cannot read; they are left out`);
    }
    return { ...raw, grants };
  };

  /**
   * A setup the host cannot read, from a later version among the reasons, is forgotten with a
   * warning: it only says how the last run of the setup commands went, and must not make the
   * network and the grants unreadable with it.
   */
  const withReadableSetup = (spaceId, raw) => {
    if (!(raw instanceof Object) || raw.setup === undefined || raw.setup === null) return raw;
    if (setupSchema.safeParse(raw.setup).success) return raw;
    logger.warn?.(`[spaces] the record of space ${spaceId} holds a setup this host cannot read; it is left out`);
    return { ...raw, setup: null };
  };

  const read = (spaceId) => {
    const file = fileOf(spaceId);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', record: null };
      logger.warn?.(`[spaces] could not read the record of space ${spaceId}: ${error?.code ?? error?.message ?? error}`);
      return { status: 'unreadable', record: null };
    }
    try {
      const parsed = recordSchema.safeParse(withReadableSetup(spaceId, withReadableGrants(spaceId, JSON.parse(text))));
      if (parsed.success) return { status: 'ok', record: parsed.data };
    } catch {
      // Reported below.
    }
    logger.warn?.(`[spaces] the record of space ${spaceId} is not one this host wrote`);
    return { status: 'unreadable', record: null };
  };

  const write = (spaceId, record) => {
    const checked = recordSchema.parse({ version: 1, ...record });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = fileOf(spaceId);
    // Through a temporary name, so a crash in the middle never leaves half a record.
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    return checked;
  };

  /** Changes some fields of a record that exists. A record that is missing or unreadable is not written. */
  const update = (spaceId, changes) => {
    const current = read(spaceId);
    if (current.status !== 'ok') return current;
    return { status: 'ok', record: write(spaceId, { ...current.record, ...changes }) };
  };

  const remove = (spaceId) => {
    try {
      fs.rmSync(fileOf(spaceId), { force: true });
    } catch (error) {
      logger.warn?.(`[spaces] could not remove the record of space ${spaceId}: ${error?.code ?? error?.message ?? error}`);
    }
  };

  return { read, write, update, remove };
}
