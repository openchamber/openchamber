import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { writeFileAtomic } from '../opencode/atomic-write.js';

const configSchema = z.object({
  enabled: z.boolean(),
}).strict();
const providerStateSchema = z.object({
  config: configSchema,
  exhausted: z.record(z.string(), z.number().finite().nonnegative()),
  switchedAt: z.number().finite().nonnegative(),
  switchedTo: z.string().nullable(),
}).strict();
const stateSchema = z.record(z.string(), providerStateSchema);
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

// A provider opts in only after its quota classifier has been implemented.
const providers = new Map([['openai', { usageLimit: openAIUsageLimit }]]);
const emptyProvider = () => ({ config: { enabled: false }, exhausted: {}, switchedAt: 0, switchedTo: null });

/** Only metadata from the integration catalog is read. Tokens stay in OpenCode. */
export const openCodeRotationAccounts = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const client = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''), headers });
  };
  return {
    list: async (directory, providerID) => {
      if (!directory) throw new Error('A working directory is required');
      const { data } = await client(directory).integration.list();
      return data.find((integration) => integration.id === providerID)?.connections ?? [];
    },
    activate: (credentialID) => client().credential.activate({ credentialID }),
  };
};

export const createAccountRotationRuntime = ({ dataDir, accounts, now = Date.now, isAvailable = () => true }) => {
  const file = path.join(dataDir, 'account-rotation.json');
  let pending = Promise.resolve();
  // Settings and recoveries share one sequence: two failed turns cannot both
  // exhaust the account the first one just activated.
  const serial = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const read = () => {
    try { return stateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
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
    supports: (providerID) => isAvailable() && providers.has(providerID),
    describe: (providerID) => serial(() => (read()[providerID] ?? emptyProvider()).config),
    save: (providerID, input, directory) => serial(async () => {
      if (!isAvailable() || !providers.has(providerID)) throw Object.assign(new Error('Account rotation is unavailable for this provider'), { statusCode: 501 });
      const parsed = configSchema.safeParse(input);
      if (!parsed.success) throw Object.assign(new Error('Invalid account rotation settings'), { statusCode: 400 });
      const config = parsed.data;
      if (config.enabled) {
        const connections = eligible(await accounts.list(directory, providerID));
        if (connections.length < 2) {
          throw Object.assign(new Error('At least two saved sign-ins are required'), { statusCode: 400 });
        }
      }
      const state = read();
      write({ ...state, [providerID]: { ...(state[providerID] ?? emptyProvider()), config } });
      return config;
    }),
    recover: ({ providerID, error, startedAt, directory, allowSwitch = true }) => serial(async () => {
      const limit = isAvailable() ? providers.get(providerID)?.usageLimit(error) : null;
      if (!limit) return { limited: false, retry: false };
      const declined = { limited: true, retry: false };
      const stored = read();
      const state = stored[providerID] ?? emptyProvider();
      if (!state.config.enabled) return { limited: false, retry: false };
      const persist = (next) => write({ ...stored, [providerID]: next });
      const connections = await accounts.list(directory, providerID);
      const active = connections.find((connection) => connection.type === 'credential');
      const pool = eligible(connections);
      if (!active || !pool.some((connection) => connection.id === active.id)) return declined;
      const recovered = (account) => ({ limited: true, retry: true, accountLabel: account.label || account.id });
      const time = now();
      // An older request may fail AFTER another turn switches the account.
      // Its start time prevents charging that failure to the newly active one.
      if (startedAt > 0 && startedAt <= state.switchedAt && active.id === state.switchedTo) {
        return allowSwitch && (state.exhausted[active.id] ?? 0) <= time ? recovered(active) : declined;
      }
      const exhausted = Object.fromEntries(Object.entries(state.exhausted).filter(([, reset]) => reset > time));
      exhausted[active.id] = limit.resetAt > time ? limit.resetAt : time + HOUR_MS;
      const start = pool.findIndex((connection) => connection.id === active.id);
      const next = Array.from({ length: pool.length - 1 }, (_, offset) => pool[(start + offset + 1) % pool.length])
        .find((connection) => !exhausted[connection.id]);
      // Record exhaustion before activation. A failed activation must never
      // turn a failed account back into an eligible one.
      persist({ ...state, exhausted });
      if (!allowSwitch || !next) return declined;
      await accounts.activate(next.id);
      persist({ ...state, exhausted, switchedAt: now(), switchedTo: next.id });
      return recovered(next);
    }),
  };
};

export const registerAccountRotationRoutes = (app, { runtime, resolveProjectDirectory }) => {
  app.get('/api/provider/:providerID/account-rotation', async (req, res) => {
    if (!runtime.supports(req.params.providerID)) return res.status(501).json({ error: 'Account rotation is unavailable for this provider' });
    try { res.json(await runtime.describe(req.params.providerID)); }
    catch { res.status(500).json({ error: 'Could not read account rotation settings' }); }
  });
  app.put('/api/provider/:providerID/account-rotation', async (req, res) => {
    if (!runtime.supports(req.params.providerID)) return res.status(501).json({ error: 'Account rotation is unavailable for this provider' });
    try {
      const resolved = await resolveProjectDirectory(req);
      if (!resolved.directory) return res.status(400).json({ error: 'A working directory is required' });
      return res.json(await runtime.save(req.params.providerID, req.body, resolved.directory));
    } catch (error) {
      return res.status(error.statusCode ?? 500).json({ error: error.statusCode === 400 ? error.message : 'Could not save account rotation settings' });
    }
  });
};
