import express from 'express';

import { addNote, readNotes, readPlanStore, setModel, setPool, upsertPlan, writePlanStore } from './plans.js';

/** The plan fields a client may set. Enumerations and dates are checked where the record is written. */
const PLAN_FIELDS = [
  'id',
  'providerID',
  'label',
  'plan',
  'coverage',
  'fee',
  'quotas',
  'expiresOn',
  'status',
  'verifiedAt',
  'verifiedFrom',
  'howToCheck',
  'notes',
];

const pick = (body, keys) =>
  Object.fromEntries(keys.filter((key) => body && Object.prototype.hasOwnProperty.call(body, key)).map((key) => [key, body[key]]));

const invalid = (message, code) => Object.assign(new Error(message), { status: 400, code });

const clampLimit = (value) => {
  const text = typeof value === 'string' ? value : '';
  if (!/^[1-9]\d*$/.test(text)) return 50;
  const number = Number(text);
  return Number.isSafeInteger(number) ? Math.min(number, 500) : 50;
};

/**
 * Routes for the plan store: the plans, each model's cost tier, each pool's
 * purpose, and the notes. Writes go to OpenCode's data directory, where
 * OpenCode's `plan_info` tool reads them.
 */
export const registerPlanRoutes = (app, { dataDir, now = () => new Date() } = {}) => {
  const respond = (handler) => async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      const status = error?.status ?? (error?.name === 'ZodError' ? 400 : 500);
      res.status(status).json({
        error: error instanceof Error ? error.message : String(error),
        code: error?.code ?? (status === 400 ? 'INVALID_PLAN' : 'PLAN_ERROR'),
      });
    }
  };

  app.get(
    '/api/routing/plans',
    respond(() => {
      const store = readPlanStore(dataDir);
      const notes = readNotes({ limit: 20 }, dataDir);
      return { plans: store.plans, models: store.models, pools: store.pools, notes: notes.notes, skippedNotes: notes.skipped };
    }),
  );

  app.put(
    '/api/routing/plans/record',
    express.json({ limit: '64kb' }),
    respond((req) => {
      const { store, plan } = upsertPlan(readPlanStore(dataDir), pick(req.body, PLAN_FIELDS), now().toISOString());
      writePlanStore(store, dataDir);
      return plan;
    }),
  );

  app.put(
    '/api/routing/plans/model',
    express.json({ limit: '16kb' }),
    respond((req) => {
      const model = req.body?.model;
      if (typeof model !== 'string' || !model.includes('/')) throw invalid('model must be provider/model', 'INVALID_TIER');
      const next = setModel(readPlanStore(dataDir), model, pick(req.body, ['tier', 'coveredBy', 'note']), now().toISOString());
      writePlanStore(next, dataDir);
      return next.models[model];
    }),
  );

  app.put(
    '/api/routing/plans/pool',
    express.json({ limit: '16kb' }),
    respond((req) => {
      const id = req.body?.id;
      if (typeof id !== 'string' || id.trim() === '') throw invalid('A pool id is needed.', 'INVALID_POOL');
      const next = setPool(readPlanStore(dataDir), id.trim(), pick(req.body, ['tier', 'purpose']), now().toISOString());
      writePlanStore(next, dataDir);
      return next.pools[id.trim()];
    }),
  );

  app.get(
    '/api/routing/plans/notes',
    respond((req) => readNotes({ limit: clampLimit(req.query?.limit) }, dataDir)),
  );

  app.post(
    '/api/routing/plans/notes',
    express.json({ limit: '16kb' }),
    respond((req) =>
      addNote(
        { ...pick(req.body, ['text', 'kind', 'providerID', 'planID', 'modelID', 'poolID']), source: 'ui' },
        now().toISOString(),
        dataDir,
      ),
    ),
  );
};
