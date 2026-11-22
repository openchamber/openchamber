/**
 * Which pool target shares which plan: an OpenChamber-only map from a target
 * reference (`provider/model`) to a plan id from the plan store. Two targets
 * pointed at the same plan id are siblings on one subscription, so the pool
 * health view can combine their headroom and a bust on one is understood to
 * leave the others untouched.
 *
 * This file is OpenChamber's own concept, not OpenCode's: it lives in
 * OpenChamber's data directory (unlike `plans.json`, which OpenCode's
 * `plan_info` tool also reads and must not gain fields OpenCode does not
 * expect), and nothing outside this feature reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';

import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { readPlanStore } from './plans.js';

const FILE_NAME = 'pool-plan-links.json';
const MAX_POOL_PLAN_LINKS_BYTES = 1024 * 1024;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const linksPath = (dataDir) => path.join(dataDir, FILE_NAME);

export const emptyPoolPlanLinks = () => ({ version: 1, links: {} });

const nonBlank = z.string().refine((value) => value.trim() !== '');

const linksFileSchema = z.object({ version: z.literal(1), links: z.record(nonBlank, nonBlank) });

const linkRequestSchema = z.object({ target: nonBlank, planID: z.string().nullish() });

const validate = (value) => linksFileSchema.safeParse(value).data ?? null;

/** The target→plan map. A missing file reads as empty; a malformed one throws, never silently drops links. */
export const readPoolPlanLinks = (dataDir) => {
  const file = linksPath(dataDir);
  let result;
  try {
    result = readBoundedFileSync(file, MAX_POOL_PLAN_LINKS_BYTES);
  } catch (error) {
    throw httpError(409, `${file} is unreadable: ${error?.code ?? 'error'}. Fix its permissions or move it before linking pool targets to plans.`, 'POOL_LINKS_UNREADABLE');
  }
  if (!result.ok) {
    if (result.reason === 'missing') return emptyPoolPlanLinks();
    if (result.reason === 'too-large') {
      throw httpError(409, `${file} exceeds the ${MAX_POOL_PLAN_LINKS_BYTES}-byte pool-plan-links limit. Fix or move it before linking pool targets to plans.`, 'POOL_LINKS_MALFORMED');
    }
    throw httpError(409, `${file} is not a regular file. Fix or move it before linking pool targets to plans.`, 'POOL_LINKS_MALFORMED');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.buffer.toString('utf8'));
  } catch {
    throw httpError(409, `${file} is not valid JSON. Fix or move it before linking pool targets to plans.`, 'POOL_LINKS_MALFORMED');
  }
  const valid = validate(parsed);
  if (!valid) {
    throw httpError(409, `${file} does not match the pool-plan-links format.`, 'POOL_LINKS_MALFORMED');
  }
  return valid;
};

export const writePoolPlanLinks = (value, dataDir) => {
  const valid = validate(value);
  if (!valid) throw httpError(400, 'links must map a target reference to a plan id', 'INVALID_POOL_LINKS');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = linksPath(dataDir);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`);
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporary, file);
  return valid;
};

/** Sets or clears one target's plan link (`planID: null` removes it). */
export const setPoolPlanLink = (store, target, planID, dataDir) => {
  const links = { ...store.links };
  if (planID === null || planID === undefined || planID === '') delete links[target];
  else links[target] = planID;
  return writePoolPlanLinks({ ...store, links }, dataDir);
};

// Links are read through `GET /api/model-routes/health`, which resolves each
// target's plan, so this module exposes only the write.
export const registerPoolPlanLinkRoutes = (app, { openchamberDataDir, loadPlanStore = readPlanStore } = {}) => {
  app.put('/api/model-routes/plan-links', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const request = linkRequestSchema.safeParse(req.body);
      if (!request.success) {
        return res.status(400).json({ error: 'target must be a provider/model reference', code: 'INVALID_POOL_LINKS' });
      }
      const { target, planID } = request.data;
      // Clearing a link always works, so one left by a deleted plan can be removed.
      if (planID && !loadPlanStore().plans.some((plan) => plan.id === planID)) {
        return res.status(400).json({ error: `There is no plan "${planID}".`, code: 'UNKNOWN_PLAN' });
      }
      res.json(setPoolPlanLink(readPoolPlanLinks(openchamberDataDir), target, planID ?? null, openchamberDataDir));
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to save the pool-plan link', code: error?.code });
    }
  });
};
