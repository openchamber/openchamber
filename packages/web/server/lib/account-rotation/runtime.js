import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { writeFileAtomic } from '../opencode/atomic-write.js';

const configSchema = z.object({
  enabled: z.boolean(),
  accountIds: z.array(z.string().min(1).max(200)).max(100),
}).strict().refine((value) => new Set(value.accountIds).size === value.accountIds.length);
const stateSchema = z.object({
  config: configSchema,
  exhausted: z.record(z.string(), z.number().finite().nonnegative()),
  switchedAt: z.number().finite().nonnegative(),
  switchedTo: z.string().nullable(),
}).strict();
const errorSchema = z.object({
  message: z.string(),
  status: z.number().optional(),
  response: z.object({ body: z.string() }).optional(),
});
const usageBodySchema = z.object({ error: z.object({
  type: z.string().optional(),
  code: z.string().optional(),
  resets_at: z.number().finite().optional(),
}) });
const HOUR_MS = 60 * 60 * 1000;

/** A generic 429 is a short rate limit and remains OpenCode's retry decision. */
export const openAIUsageLimit = (error) => {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success) return null;
  const failure = parsed.data;
  if (failure.status !== undefined && failure.status !== 429) return null;
  let body = null;
  try { body = usageBodySchema.safeParse(JSON.parse(failure.response?.body ?? '')).data?.error; } catch { /* No JSON body. */ }
  const code = body?.type === 'usage_limit_reached' || body?.code === 'usage_limit_reached';
  if (!code && !/\b(?:you(?:'ve| have) hit your usage limit|usage limit (?:has been )?reached)\b/i.test(failure.message)) return null;
  return { resetAt: body?.resets_at ? body.resets_at * 1000 : null };
};

/** Only metadata from the integration catalog is read. Tokens stay in OpenCode. */
export const openCodeRotationAccounts = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const client = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''), headers });
  };
  return {
    list: async (directory) => {
      if (!directory) throw new Error('A working directory is required');
      const { data } = await client(directory).integration.list();
      return data.find((integration) => integration.id === 'openai')?.connections ?? [];
    },
    activate: (credentialID) => client().credential.activate({ credentialID }),
  };
};

export const createAccountRotationRuntime = ({ dataDir, accounts, now = Date.now }) => {
  const file = path.join(dataDir, 'account-rotation.json');
  let pending = Promise.resolve();
  // Settings and recoveries share one sequence: two failed goals cannot both
  // exhaust the account the first one just activated.
  const serial = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const read = () => {
    try { return stateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { config: { enabled: false, accountIds: [] }, exhausted: {}, switchedAt: 0, switchedTo: null };
      throw new Error('Could not read account rotation settings');
    }
  };
  const write = (state) => {
    fs.mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(state));
  };
  const eligible = (connections) => connections.filter((connection) => (
    connection.type === 'credential' && connection.method === 'oauth' && !connection.status
  ));

  return {
    describe: () => serial(() => read().config),
    save: (input, directory) => serial(async () => {
      const parsed = configSchema.safeParse(input);
      if (!parsed.success || (parsed.data.enabled && parsed.data.accountIds.length < 2)) {
        throw Object.assign(new Error('Select at least two distinct saved sign-ins'), { statusCode: 400 });
      }
      const config = parsed.data;
      if (config.enabled) {
        const connections = eligible(await accounts.list(directory));
        if (config.accountIds.some((id) => !connections.some((connection) => connection.id === id))) {
          throw Object.assign(new Error('An account is missing or needs a new sign-in'), { statusCode: 400 });
        }
      }
      const state = read();
      write({ ...state, config });
      return config;
    }),
    recover: ({ providerID, error, startedAt, directory }) => serial(async () => {
      const limit = providerID === 'openai' ? openAIUsageLimit(error) : null;
      if (!limit) return false;
      const state = read();
      if (!state.config.enabled) return false;
      const connections = await accounts.list(directory);
      const active = connections.find((connection) => connection.type === 'credential');
      const pool = eligible(connections).filter((connection) => state.config.accountIds.includes(connection.id));
      if (!active || !pool.some((connection) => connection.id === active.id)) return false;
      const time = now();
      // An older request may fail AFTER another goal switches the account.
      // Its start time prevents charging that failure to the newly active one.
      if (startedAt > 0 && startedAt <= state.switchedAt && active.id === state.switchedTo) {
        return (state.exhausted[active.id] ?? 0) <= time;
      }
      const exhausted = Object.fromEntries(Object.entries(state.exhausted).filter(([, reset]) => reset > time));
      exhausted[active.id] = limit.resetAt > time ? limit.resetAt : time + HOUR_MS;
      const ordered = state.config.accountIds;
      const start = ordered.indexOf(active.id);
      const next = Array.from({ length: ordered.length - 1 }, (_, offset) => ordered[(start + offset + 1) % ordered.length])
        .find((id) => !exhausted[id] && pool.some((connection) => connection.id === id));
      // Record exhaustion before activation. A failed activation must never
      // turn a failed account back into an eligible one.
      write({ ...state, exhausted });
      if (!next) return false;
      await accounts.activate(next);
      write({ ...state, exhausted, switchedAt: now(), switchedTo: next });
      return true;
    }),
  };
};

export const registerAccountRotationRoutes = (app, { runtime, resolveProjectDirectory }) => {
  app.get('/api/provider/account-rotation', async (_req, res) => {
    try { res.json(await runtime.describe()); }
    catch { res.status(500).json({ error: 'Could not read account rotation settings' }); }
  });
  app.put('/api/provider/account-rotation', async (req, res) => {
    try {
      const resolved = await resolveProjectDirectory(req);
      if (!resolved.directory) return res.status(400).json({ error: 'A working directory is required' });
      return res.json(await runtime.save(req.body, resolved.directory));
    } catch (error) {
      return res.status(error.statusCode ?? 500).json({ error: error.statusCode === 400 ? error.message : 'Could not save account rotation settings' });
    }
  });
};
