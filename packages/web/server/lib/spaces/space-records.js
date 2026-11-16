
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { requireSpaceId } from './labels.js';
import { MAX_KEPT_OUTPUT_CHARACTERS, MAX_SETUP_COMMAND_LENGTH, MAX_SETUP_COMMANDS } from './space-setup.js';
import { sanitizeSpaceTaskTitle, spaceTaskTitleSchema } from './task-title.js';
import { SpaceError } from './errors.js';

const RECORDS_DIRECTORY = path.join('spaces', 'records');

const NETWORK_MODES = Object.freeze(['allowlist', 'open']);
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const MAX_DOMAINS = 200;

export const domainSchema = z.string().regex(DOMAIN_PATTERN);

export const networkSchema = z.object({
  mode: z.enum(NETWORK_MODES),
  domains: z.array(domainSchema).max(MAX_DOMAINS).default([]),
});

const historySchema = z.enum(['pending', 'sent', 'already_complete', 'host_shallow', 'failed']);

const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const providerIdSchema = z.string().regex(GRANT_ID_PATTERN);
// external: https://zod.dev/api#refinements Refinements can run after a URL check fails, so URL parsing must not throw.
const isHttpUrl = (value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};
const upstreamSchema = z.string().url().refine(isHttpUrl, 'http or https');
export const secretSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/) }).strict(),
  z.object({ kind: z.literal('typed') }).strict(),
  z.object({ kind: z.literal('stored'), integration: z.string().regex(GRANT_ID_PATTERN) }).strict(),
]);
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
  z.object({
    kind: z.literal('login'),
    id: z.string().regex(GRANT_ID_PATTERN),
    provider: z.string().regex(GRANT_ID_PATTERN),
    method: z.string().regex(/^[a-z0-9-]{1,64}$/),
  }).strict(),
  z.object({
    kind: z.literal('custom'),
    id: z.string().regex(GRANT_ID_PATTERN),
    provider: z.string().regex(GRANT_ID_PATTERN),
  }).strict(),
]);
const MAX_GRANTS = 100;

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
    startedAt: z.string().optional(),
    finishedAt: z.string(),
  }).strict(),
]);

const recordSchema = z.object({
  version: z.literal(1),
  placeId: z.string().min(1).default('docker'),
  name: z.string().nullable().default(null),
  taskTitle: spaceTaskTitleSchema.nullable().default(null),
  created: z.string().nullable().default(null),
  network: networkSchema,
  repository: z.string().min(1).nullable().default(null),
  spacePath: z.string().min(1).nullable().default(null),
  base: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable().default(null),
  history: historySchema.default('pending'),
  grants: z.array(grantSchema).max(MAX_GRANTS).default([]),
  setup: setupSchema.nullable().default(null),
});

export function createSpaceRecords({ dataDir, logger = console }) {
  const directory = path.join(dataDir, RECORDS_DIRECTORY);
  const fileOf = (spaceId) => path.join(directory, `${requireSpaceId(spaceId)}.json`);

  const withReadableGrants = (spaceId, raw) => {
    if (!(raw instanceof Object) || !Array.isArray(raw.grants)) return raw;
    const grants = raw.grants.filter((grant) => grantSchema.safeParse(grant).success);
    if (grants.length < raw.grants.length) {
      logger.warn?.(`[spaces] the record of space ${spaceId} holds ${raw.grants.length - grants.length} grant(s) this host cannot read; they are left out`);
    }
    return { ...raw, grants };
  };

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
      const raw = withReadableSetup(spaceId, withReadableGrants(spaceId, JSON.parse(text)));
      if (raw instanceof Object && raw.taskTitle != null && !spaceTaskTitleSchema.safeParse(raw.taskTitle).success) {
        logger.warn?.(`[spaces] the record of space ${spaceId} holds a task title this host cannot read; it is left out`);
        raw.taskTitle = null;
      }
      const parsed = recordSchema.safeParse(raw);
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
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    return checked;
  };

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

  const list = () => {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.(`[spaces] could not list the records: ${error?.code ?? error?.message ?? error}`);
      return [];
    }
    return names
      .filter((name) => /^[0-9a-f]{12}\.json$/.test(name))
      .map((name) => ({ id: name.slice(0, -5), ...read(name.slice(0, -5)) }))
      .filter((entry) => entry.status === 'ok')
      .map(({ id, record }) => ({ id, record }));
  };

  const setTaskTitle = (spaceId, { title: rawTitle, by }) => {
    z.enum(['user', 'agent']).parse(by);
    const current = read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The space record cannot be read.');
    const title = sanitizeSpaceTaskTitle(rawTitle);
    if (by === 'agent' && (!title || current.record.taskTitle?.by === 'user')) {
      return { applied: false, taskTitle: current.record.taskTitle };
    }
    const taskTitle = title ? { title, by } : null;
    if (current.record.taskTitle?.title !== title || current.record.taskTitle?.by !== by) write(spaceId, { ...current.record, taskTitle });
    return { applied: true, taskTitle };
  };

  return { read, write, update, remove, list, setTaskTitle };
}
