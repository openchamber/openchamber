import { createHash } from 'node:crypto';
import os from 'node:os';
import { botEffectSchema } from './schema.js';

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && value === Object(value) && !(value instanceof Function)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
export const botInputDigest = (input) => createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');

class BotEffectBlocked extends Error {
  constructor(code, key, state) {
    super(`Bot operation ${key} requires attention: ${code}`);
    this.code = code; this.key = key; this.state = state; this.status = 409;
  }
}

/** The caller owns the project execution lock. Store locks never surround I/O. */
export const createBotEffects = ({ store, journal, now = Date.now, owner = { pid: process.pid, host: os.hostname() } }) => {
  const mutate = async (projectId, itemId, change) => {
    const committed = await store.update(projectId, (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => item.id === itemId ? change(item) : item) } }));
    const item = committed.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error('Bot item no longer exists');
    return item;
  };
  const settle = async (projectId, itemId, effect, result) => {
    const fields = { key: effect.key, kind: effect.kind, inputDigest: effect.inputDigest, authority: effect.authority, createdAt: effect.createdAt, updatedAt: now() };
    const next = botEffectSchema.parse(result.state === 'succeeded'
      ? { ...fields, state: 'succeeded', receipt: result.result }
      : { ...fields, state: result.state, code: result.code ?? 'BOT_OUTCOME_UNKNOWN' });
    await mutate(projectId, itemId, (item) => ({ ...item, effects: item.effects.map((entry) => entry.key === effect.key ? next : entry) }));
    if (next.state !== 'succeeded') throw new BotEffectBlocked(next.code, next.key, next.state);
    return next.receipt;
  };
  const run = async ({ projectId, itemId, key, kind, authority, request, execute, executePrepared, reconcile, beforeDispatch }) => {
    // Descriptors use their wire representation, including absent optional fields.
    request = JSON.parse(JSON.stringify(request));
    const inputDigest = botInputDigest(request);
    let item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!item) throw new Error('Bot item not found');
    let effect = item.effects.find((entry) => entry.key === key);
    if (!effect) {
      await journal.update(projectId, itemId, (entry) => ({ ...entry, operations: { ...entry.operations, [key]: request } }));
      const timestamp = now();
      const prepared = botEffectSchema.parse({ key, kind, inputDigest, authority, createdAt: timestamp, updatedAt: timestamp, state: 'prepared' });
      item = await mutate(projectId, itemId, (current) => ({ ...current, effects: [...current.effects, prepared] }));
      effect = item.effects.find((entry) => entry.key === key);
    } else if (effect.inputDigest !== inputDigest || botInputDigest(effect.authority) !== botInputDigest(authority)) {
      throw new BotEffectBlocked('BOT_EFFECT_AUTHORITY_CHANGED', key, effect.state);
    }
    if (effect.state === 'succeeded') return effect.receipt;
    if (effect.state === 'refused') throw new BotEffectBlocked(effect.code, key, effect.state);
    if (effect.state === 'dispatching' || effect.state === 'outcome-unknown') {
      let result;
      try { result = await reconcile(request); }
      catch { result = { state: 'outcome-unknown', code: 'BOT_RECONCILIATION_UNAVAILABLE' }; }
      if (effect.state === 'outcome-unknown' && result.state === 'outcome-unknown') throw new BotEffectBlocked(effect.code, key, effect.state);
      return settle(projectId, itemId, effect, result);
    }
    if (beforeDispatch) {
      try { await beforeDispatch(); }
      catch (failure) {
        if (failure?.state === 'refused') return settle(projectId, itemId, effect, { state: 'refused', code: failure.code });
        throw failure;
      }
    }
    let claimed = false;
    const claimDispatch = async () => {
      if (claimed) return;
      let acquired = false;
      const latest = await mutate(projectId, itemId, (current) => ({ ...current, effects: current.effects.map((entry) => {
        if (entry.key !== key || entry.state !== 'prepared') return entry;
        acquired = true;
        return { ...entry, state: 'dispatching', owner, updatedAt: now() };
      }) }));
      if (!acquired) throw new BotEffectBlocked('BOT_EFFECT_NOT_PREPARED', key, latest.effects.find((entry) => entry.key === key)?.state);
      claimed = true;
    };
    let receipt;
    try {
      if (executePrepared) receipt = await executePrepared(request, claimDispatch);
      else { await claimDispatch(); receipt = await execute(request); }
      // Read-only provider replays can complete without admitting another write.
      await claimDispatch();
    }
    catch (error) {
      if (!claimed) throw error;
      // Only an explicit executor refusal proves that no write happened.
      const state = error?.state === 'refused' ? 'refused' : 'outcome-unknown';
      return settle(projectId, itemId, effect, { state, code: error?.code ?? 'BOT_DISPATCH_OUTCOME_UNKNOWN' });
    }
    // A failed receipt write must leave dispatching on disk for reconciliation.
    return settle(projectId, itemId, effect, { state: 'succeeded', result: receipt });
  };
  const recover = async ({ projectId, itemId, key, execute, executePrepared, reconcile }) => {
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    const effect = item?.effects.find((entry) => entry.key === key);
    if (!effect) throw new Error('Bot effect not found');
    const request = (await journal.read(projectId, itemId)).operations[key];
    if (request === undefined) throw new BotEffectBlocked('BOT_EFFECT_REQUEST_MISSING', key, effect.state);
    return run({ projectId, itemId, key, kind: effect.kind, authority: effect.authority, request, execute, executePrepared, reconcile });
  };
  return { run, recover };
};
