import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLimitFailoverRuntime } from './runtime.js';
import { classifyLimitFailure, DEFAULT_EXHAUSTION_MS, parseLimitResetAt, parseModelSetting } from './policy.js';

const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const ACCOUNT_A = { id: 'cred_a', label: 'Work' };
const ACCOUNT_B = { id: 'cred_b', label: 'Personal' };
const ACCOUNT_C = { id: 'cred_c', label: 'Spare' };

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = ({ settings = { accountSwitchProviders: ['anthropic'] }, now = () => NOW } = {}) => {
  const broadcastUiEvent = vi.fn();
  const runtime = createLimitFailoverRuntime({
    fsPromises: fs,
    path,
    instanceDir: os.tmpdir(),
    readSettings: async () => settings,
    authorizeRequest: (req) => req.headers.authorization === 'Bearer token',
    broadcastUiEvent,
    now,
  });
  return { runtime, broadcastUiEvent };
};

const quotaReport = (overrides = {}) => ({
  sessionID: 'ses_1',
  providerID: 'anthropic',
  modelID: 'claude-opus',
  error: { type: 'provider.quota', message: 'usage limit reached', body: null },
  proposed: { retry: false },
  credentials: [ACCOUNT_A, ACCOUNT_B],
  activeCredentialID: ACCOUNT_A.id,
  ...overrides,
});

describe('limit failure classification', () => {
  it('counts a quota error and a rate limit that waits a minute or more', () => {
    expect(classifyLimitFailure(quotaReport(), NOW)).not.toBeNull();
    const rateLimit = (delay) => quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay } });
    expect(classifyLimitFailure(rateLimit(15 * 60_000), NOW)).not.toBeNull();
    expect(classifyLimitFailure(rateLimit(8_000), NOW)).toBeNull();
    expect(classifyLimitFailure(quotaReport({ error: { type: 'provider.auth', message: '', body: null } }), NOW)).toBeNull();
  });

  it('reads the reset from the body, and skips an account an hour when the body says nothing', () => {
    const body = (value) => ({ type: 'provider.quota', message: '', body: JSON.stringify(value) });
    expect(parseLimitResetAt(body({ error: { resets_in_seconds: 7200 } }), NOW)).toBe(NOW + 7_200_000);
    expect(parseLimitResetAt(body({ error: { type: 'rate_limit', resets_at: '2026-10-20T12:20:00.000Z' } }), NOW)).toBe(Date.parse('2026-10-20T12:20:00.000Z'));
    expect(parseLimitResetAt(body({ resets_at: Math.floor(NOW / 1000) + 600 }), NOW)).toBe(NOW + 600_000);
    expect(parseLimitResetAt(body({ resets_at: '2026-10-19T00:00:00.000Z' }), NOW)).toBeNull();
    expect(classifyLimitFailure(quotaReport(), NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS, scope: { kind: 'account' }, named: false });
  });

  it('counts OpenCode free-tier exhaustion and Console spend limits as quota errors', () => {
    for (const type of ['provider.free-limit', 'provider.budget-limit', 'provider.model-budget-limit', 'provider.go-limit', 'provider.chatgpt-limit']) {
      const report = quotaReport({ providerID: 'opencode', error: { type, message: '', body: null } });
      expect(classifyLimitFailure(report, NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS, scope: { kind: 'account' }, named: false });
    }
  });

  it('takes the reset from retryAfterMs before the body, and ignores a zero wait', () => {
    const error = (retryAfterMs) => ({ type: 'provider.quota', message: '', body: JSON.stringify({ resets_in_seconds: 7200 }), retryAfterMs });
    expect(parseLimitResetAt(error(5 * 60_000), NOW)).toBe(NOW + 300_000);
    expect(parseLimitResetAt(error(0), NOW)).toBe(NOW + 7_200_000);
    const longRateLimit = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null, retryAfterMs: 10 * 60_000 },
      proposed: { retry: true, delay: 10_000 },
    });
    expect(classifyLimitFailure(longRateLimit, NOW)).toEqual({ resetAt: NOW + 600_000, scope: { kind: 'account' }, named: true });
  });

  it('treats a rejected rate limit as exhausted when only the captured headers say the reset', () => {
    // The Fable case: a 429 with no retry-after and no reset in the rewritten
    // body, whose anthropic-ratelimit-unified-* headers name the window.
    const fable = quotaReport({
      modelID: 'claude-fable-5-2',
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: false },
      captured: { status: 'rejected', resetAt: NOW + 3 * 24 * 60 * 60_000, claim: 'seven_day_fable' },
    });
    expect(classifyLimitFailure(fable, NOW)).toEqual({
      resetAt: NOW + 3 * 24 * 60 * 60_000,
      scope: { kind: 'model', family: 'fable' },
      named: true,
    });
    const short = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: true, delay: 8_000 },
      captured: { status: 'allowed', resetAt: NOW + 20_000 },
    });
    expect(classifyLimitFailure(short, NOW)).toBeNull();
  });

  it('scopes the mark to the claim, falling back to the session model family', () => {
    const scoped = (claim, modelID = 'claude-opus-5-5') => classifyLimitFailure(quotaReport({
      modelID,
      error: { type: 'provider.quota', message: '', body: null },
      captured: { status: 'rejected', resetAt: NOW + 3_600_000, claim },
    }), NOW)?.scope;
    expect(scoped('seven_day_opus')).toEqual({ kind: 'model', family: 'opus' });
    expect(scoped('seven_day_sonnet', 'claude-sonnet-5-5')).toEqual({ kind: 'model', family: 'sonnet' });
    expect(scoped('seven_day_cowork', 'claude-opus-5-5')).toEqual({ kind: 'model', family: 'opus' });
    expect(scoped('five_hour')).toEqual({ kind: 'account' });
    expect(scoped('seven_day')).toEqual({ kind: 'account' });
  });

  it('treats a short rate limit as a throttle even when the body names a near reset', () => {
    const report = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: JSON.stringify({ retry_after: 20 }) },
      proposed: { retry: true, delay: 20_000 },
    });
    expect(classifyLimitFailure(report, NOW)).toBeNull();
  });

  it('parses the stored fallback model, keeping slashes in the model id', () => {
    expect(parseModelSetting('openrouter/anthropic/claude-sonnet')).toEqual({ providerID: 'openrouter', id: 'anthropic/claude-sonnet' });
    expect(parseModelSetting('openai/gpt-5.6', 'high')).toEqual({ providerID: 'openai', id: 'gpt-5.6', variant: 'high' });
    expect(parseModelSetting('openai/gpt-5.6', '')).toEqual({ providerID: 'openai', id: 'gpt-5.6' });
    expect(parseModelSetting('nomodel')).toBeNull();
    expect(parseModelSetting('')).toBeNull();
  });
});

describe('limit failover decisions', () => {
  const pinnedApp = (settings) => {
    const created = createRuntime(settings);
    const app = express();
    created.runtime.registerRoutes(app, express);
    created.runtime.registerUiRoutes(app, express);
    return { ...created, app };
  };

  it('switches an opted-in provider to its next account, and announces it once the plugin made the switch', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const answer = await runtime.decide(quotaReport());
    expect(answer).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(broadcastUiEvent).not.toHaveBeenCalled();

    expect(runtime.settle(answer.ticket, true)).toBe(true);
    expect(broadcastUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'account', sessionId: 'ses_1', providerId: 'anthropic', fromAccount: 'Work', toAccount: 'Personal' },
    });
    // A ticket settles once.
    expect(runtime.settle(answer.ticket, true)).toBe(false);
  });

  it('announces nothing for a switch the plugin could not make, and forgets it', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({ now: () => now });
    const answer = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(answer.ticket, false);
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    now += 1_000;
    // B was never made active, so a failure on B is B's own: no grace retry.
    const onB = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(onB)).resolves.toEqual({ action: 'none' });
  });

  it('waits out a Z.ai quota reset named in the message, instead of stopping', async () => {
    const { runtime } = createRuntime({ settings: {} });
    // 20:00 Beijing is 12:00 UTC, two hours after NOW.
    const report = quotaReport({
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      error: { type: 'provider.quota', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-20 20:00:00', body: null },
    });
    await expect(runtime.decide(report)).resolves.toEqual({ action: 'wait', delay: 2 * 60 * 60_000 + 15_000 });
  });

  it('does not wait out a reset more than a day away', async () => {
    const { runtime } = createRuntime({ settings: {} });
    const report = quotaReport({
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      error: { type: 'provider.quota', message: 'Usage limit reached. Your limit will reset at 2026-10-22 20:00:00', body: null },
    });
    await expect(runtime.decide(report)).resolves.toEqual({ action: 'none' });
  });

  it('leaves a provider the user did not opt in alone', async () => {
    const { runtime } = createRuntime({ settings: { accountSwitchProviders: ['openai'] } });
    await expect(runtime.decide(quotaReport())).resolves.toEqual({ action: 'none' });
  });

  it('ignores a short throttle', async () => {
    const { runtime } = createRuntime();
    const report = quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay: 4_000 } });
    await expect(runtime.decide(report)).resolves.toEqual({ action: 'none' });
  });

  it('offers every stored account when no stored account is active', async () => {
    const { runtime } = createRuntime();
    // An environment key serves the provider; the stored accounts are all candidates, the last one too.
    await expect(runtime.decide(quotaReport({ credentials: [ACCOUNT_B], activeCredentialID: undefined })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('moves to the fallback model once every account has run out', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({
      settings: { accountSwitchProviders: ['anthropic'], fallbackModel: 'openai/gpt-5.6' },
      now: () => now,
    });
    await runtime.decide(quotaReport());
    now += 2 * 60_000;
    const answer = await runtime.decide(quotaReport({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id }));
    expect(answer).toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
    runtime.settle(answer.ticket, true);
    expect(broadcastUiEvent).toHaveBeenLastCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'model', sessionId: 'ses_1', providerId: 'anthropic', modelId: 'claude-opus', toProviderId: 'openai', toModelId: 'gpt-5.6' },
    });
  });

  it('switches to the fallback model with its thinking level', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'openai/gpt-5.6', fallbackVariant: 'high' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6', variant: 'high' } });
  });

  it('uses the fallback model without account switching, and stops on the fallback itself', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'anthropic/claude-sonnet' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-sonnet' } });
    await expect(runtime.decide(quotaReport({ modelID: 'claude-sonnet' }))).resolves.toEqual({ action: 'none' });
  });

  it('skips an account that ran out until its reset, then offers it again', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const three = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
    await runtime.decide(quotaReport({ credentials: three }));
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_C.id });
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('skips an account only as long as the rate limit says to wait', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const longRateLimit = (overrides) => quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: true, delay: 180_000 },
      ...overrides,
    });
    await runtime.decide(longRateLimit({}));
    now += 4 * 60_000;
    // A's three-minute wait is over, so A is the way out when B runs out.
    await expect(runtime.decide(longRateLimit({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('gives another session one retry on the account just switched to, without blaming it', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const first = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(first.ticket, true);
    now += 1_000;
    // ses_2's request went out with A, but the plugin reads B as active by now.
    const stale = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'retry' });
    // A second failure on B from the same session is real: B has run out too.
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'none' });
  });

  it('a model-scoped mark rules out only that family on the account', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const familyLimit = (family, claim, overrides = {}) => quotaReport({
      modelID: `claude-${family}-5-5`,
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: false },
      captured: { status: 'rejected', resetAt: now + 24 * 60 * 60_000, claim },
      ...overrides,
    });
    // A runs out of Fable only: the Fable session moves to B...
    await expect(runtime.decide(familyLimit('fable', 'seven_day_fable')))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    now += 2 * 60_000;
    // ...then B's five-hour window runs out with A only out of Fable: A still
    // serves every other model, so it is the way out.
    await expect(runtime.decide(familyLimit('sonnet', 'five_hour', {
      credentials: [ACCOUNT_B, ACCOUNT_A],
      activeCredentialID: ACCOUNT_B.id,
      captured: { status: 'rejected', resetAt: now + 3_600_000, claim: 'five_hour' },
    }))).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
    // A Fable session is offered neither until A's mark lifts.
    now += 2 * 60_000;
    await expect(runtime.decide(familyLimit('fable', 'seven_day_fable', {
      credentials: [ACCOUNT_B, ACCOUNT_A],
      activeCredentialID: ACCOUNT_B.id,
    }))).resolves.toEqual({ action: 'none' });
    now += 24 * 60 * 60_000;
    await expect(runtime.decide(familyLimit('fable', 'seven_day_fable', {
      credentials: [ACCOUNT_B, ACCOUNT_A],
      activeCredentialID: ACCOUNT_B.id,
    }))).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('fails a fixed session on its own account, and moves one that ran elsewhere', async () => {
    const { runtime, app } = pinnedApp();
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'fixed', credentialID: ACCOUNT_A.id })
      .expect(200);
    const fableOut = quotaReport({
      sessionID: 'ses_1',
      modelID: 'claude-fable-5-2',
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: false },
      captured: { status: 'rejected', resetAt: NOW + 24 * 60 * 60_000, claim: 'seven_day_fable' },
    });
    await expect(runtime.decide(fableOut)).resolves.toEqual({ action: 'fail' });
    // The pin skipped while A was out of Fable, so the session ran on B and
    // B's five-hour window ran out: A still serves every other model, so the
    // session moves back to it.
    await expect(runtime.decide(quotaReport({
      sessionID: 'ses_1',
      modelID: 'claude-sonnet-5-5',
      credentials: [ACCOUNT_B, ACCOUNT_A],
      activeCredentialID: ACCOUNT_B.id,
      captured: { status: 'rejected', resetAt: NOW + 3_600_000, claim: 'five_hour' },
    }))).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
    // Another session keeps the global behavior: B ran out for it, and A is
    // offered for the model its own mark does not cover.
    await expect(runtime.decide(quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('prefers the account with the most headroom in the failing family', async () => {
    const { runtime, app } = pinnedApp();
    const planUsage = (fablePercent, weeklyPercent) => ({
      five_hour: { utilization: 1, resets_at: null },
      seven_day: { utilization: weeklyPercent, resets_at: null },
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: weeklyPercent, resets_at: null, scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: fablePercent, resets_at: null, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ],
    });
    const three = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
    await request(app).post('/api/openchamber/limit-failover/usage')
      .set('authorization', 'Bearer token')
      .send({
        providerID: 'anthropic',
        accounts: [
          { id: ACCOUNT_A.id, label: ACCOUNT_A.label, usage: planUsage(100, 10) },
          { id: ACCOUNT_B.id, label: ACCOUNT_B.label, usage: planUsage(95, 5) },
          { id: ACCOUNT_C.id, label: ACCOUNT_C.label, usage: planUsage(12, 90) },
        ],
      })
      .expect(200);
    // The provider's own order after A is B; Fable headroom picks C instead.
    await expect(runtime.decide(quotaReport({
      modelID: 'claude-fable-5-2',
      credentials: three,
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: false },
      captured: { status: 'rejected', resetAt: NOW + 3_600_000, claim: 'seven_day_fable' },
    }))).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_C.id });
  });

  it('switches once when two sessions report the same account together', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const [first, second] = await Promise.all([
      runtime.decide(quotaReport({ sessionID: 'ses_1' })),
      runtime.decide(quotaReport({ sessionID: 'ses_2' })),
    ]);
    expect(first).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(second).toEqual({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    runtime.settle(first.ticket, true);
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
  });
});

describe('limit failover route', () => {
  const createApp = () => {
    const { runtime } = createRuntime();
    const app = express();
    runtime.registerRoutes(app, express);
    runtime.registerUiRoutes(app, express);
    return app;
  };

  it('refuses a caller without the managed child token', async () => {
    await request(createApp()).post('/api/openchamber/limit-failover').send(quotaReport()).expect(401);
  });

  it('refuses a malformed report', async () => {
    await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1' })
      .expect(400);
  });

  it('answers a valid report', async () => {
    const response = await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    expect(response.body).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('settles a ticket only for the managed child, once', async () => {
    const app = createApp();
    const decided = await request(app)
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/settle').send({ ticket: decided.body.ticket, applied: true }).expect(401);
    await request(app).post('/api/openchamber/limit-failover/settle').set('authorization', 'Bearer token').send({ ticket: 1 }).expect(400);
    const settled = await request(app)
      .post('/api/openchamber/limit-failover/settle')
      .set('authorization', 'Bearer token')
      .send({ ticket: decided.body.ticket, applied: true })
      .expect(200);
    expect(settled.body).toEqual({ settled: true });
  });

  it('stores, reads and clears a session account pin', async () => {
    const app = createApp();
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'preferred' })
      .expect(400);
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'fixed', credentialID: ACCOUNT_A.id })
      .expect(200);
    const read = await request(app).get('/api/openchamber/limit-failover/session-account?sessionID=ses_1').expect(200);
    expect(read.body.config).toMatchObject({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'fixed', credentialID: ACCOUNT_A.id });
    await request(app).get('/api/openchamber/limit-failover/session-account').expect(400);
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'global' })
      .expect(200, { config: null });
    const cleared = await request(app).get('/api/openchamber/limit-failover/session-account?sessionID=ses_1').expect(200);
    expect(cleared.body.config).toBeNull();
  });

  it('answers the prompt hook with the account to activate', async () => {
    const app = createApp();
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1' })
      .expect(401);
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({})
      .expect(400);
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'preferred', credentialID: ACCOUNT_A.id })
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1' })
      .expect(200, { activate: ACCOUNT_A.id });
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_2' })
      .expect(200, { activate: null });
  });

  it('stops naming an account the prompt hook should activate once the account ran out', async () => {
    const app = createApp();
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'preferred', credentialID: ACCOUNT_A.id })
      .expect(200);
    // A runs out for the whole account; the pin waits for its reset instead of
    // putting every session back on it.
    await request(app).post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport({ sessionID: 'ses_1' }))
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1' })
      .expect(200, { activate: null });
  });

  it('skips a pin that is out for the turn\'s model, and keeps it for other models', async () => {
    const app = createApp();
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'preferred', credentialID: ACCOUNT_A.id })
      .expect(200);
    // A runs out of Fable only.
    await request(app).post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport({
        sessionID: 'ses_9',
        modelID: 'claude-fable-5-2',
        error: { type: 'provider.rate-limit', message: '', body: null },
        proposed: { retry: false },
        captured: { status: 'rejected', resetAt: NOW + 24 * 60 * 60_000, claim: 'seven_day_fable' },
      }))
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1', modelID: 'claude-fable-5-2' })
      .expect(200, { activate: null });
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1', modelID: 'claude-sonnet-5-5' })
      .expect(200, { activate: ACCOUNT_A.id });
  });

  it('does not grant a grace retry to a turn that was already on its pin', async () => {
    const { runtime } = createRuntime();
    const app = express();
    runtime.registerRoutes(app, express);
    runtime.registerUiRoutes(app, express);
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'preferred', credentialID: ACCOUNT_A.id })
      .expect(200);
    // The turn started on A and A was already active: nothing switched.
    await request(app).post('/api/openchamber/limit-failover/session-account')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1', modelID: 'claude-fable-5-2', activeCredentialID: ACCOUNT_A.id })
      .expect(200, { activate: ACCOUNT_A.id });
    // So the limit A hits is A's own, and the session moves.
    await expect(runtime.decide(quotaReport({ sessionID: 'ses_1', modelID: 'claude-fable-5-2' })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('waits out a fixed session\'s named reset instead of moving it to some other account', async () => {
    const { runtime } = createRuntime();
    const app = express();
    runtime.registerRoutes(app, express);
    runtime.registerUiRoutes(app, express);
    await request(app).put('/api/openchamber/limit-failover/session-account')
      .send({ sessionID: 'ses_1', providerID: 'anthropic', mode: 'fixed', credentialID: ACCOUNT_A.id })
      .expect(200);
    // A is out of Fable, and the session ran on B, which now hits its limit.
    await runtime.decide(quotaReport({
      sessionID: 'ses_9',
      modelID: 'claude-fable-5-2',
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: false },
      captured: { status: 'rejected', resetAt: NOW + 24 * 60 * 60_000, claim: 'seven_day_fable' },
    }));
    // The pin is out for Fable too, so it does not move to C. The reset is
    // named and within a day, so the turn waits for it instead of stopping.
    await expect(runtime.decide(quotaReport({
      sessionID: 'ses_1',
      modelID: 'claude-fable-5-2',
      credentials: [ACCOUNT_B, ACCOUNT_A, ACCOUNT_C],
      activeCredentialID: ACCOUNT_B.id,
      captured: { status: 'rejected', resetAt: NOW + 3_600_000, claim: 'seven_day_fable' },
    }))).resolves.toEqual({ action: 'wait', delay: 3_600_000 + 15_000 });
  });

  it('serves the usage sweep merged with the exhaustion marks', async () => {
    const app = createApp();
    await request(app).post('/api/openchamber/limit-failover/usage')
      .set('authorization', 'Bearer token')
      .send({
        providerID: 'anthropic',
        accounts: [{ id: ACCOUNT_B.id, label: ACCOUNT_B.label, usage: { five_hour: { utilization: 5, resets_at: null } } }],
      })
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/usage')
      .set('authorization', 'Bearer token')
      .send({ providerID: 'anthropic', accounts: [] })
      .expect(400);
    await request(app).post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    const list = await request(app).get('/api/openchamber/limit-failover/accounts?providerID=anthropic').expect(200);
    const byId = Object.fromEntries(list.body.accounts.map((account) => [account.id, account]));
    expect(byId[ACCOUNT_B.id].usage.windows['5h'].usedPercent).toBe(5);
    expect(byId[ACCOUNT_A.id].usage).toBeNull();
    expect(byId[ACCOUNT_A.id].exhausted).toEqual([{ scope: '*', resetAt: NOW + DEFAULT_EXHAUSTION_MS }]);
    await request(app).get('/api/openchamber/limit-failover/accounts?providerID=openai')
      .expect(200, { providerID: 'openai', usageAt: null, accounts: [] });
  });
});

describe('limit failover plugin', () => {
  const loadPlugin = async () => {
    const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-limit-failover-'));
    temporaryDirectories.push(instanceDir);
    const runtime = createLimitFailoverRuntime({ fsPromises: fs, path, instanceDir, readSettings: async () => ({}), authorizeRequest: () => true });
    const directory = await runtime.materializePlugin();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports['.']).toBe('./index.js');
    const module = await import(`${pathToFileURL(path.join(directory, 'index.js')).href}?t=${Date.now()}`);
    return module.default;
  };

  const createContext = () => {
    const hooks = {};
    return {
      hooks,
      ctx: {
        session: {
          hook: async (name, callback) => { hooks[name] = callback; },
          switchModel: vi.fn(async () => undefined),
        },
        provider: { get: vi.fn(async () => ({ location: {}, data: { id: 'anthropic', integrationID: 'anthropic' } })) },
        integration: {
          get: vi.fn(async () => ({
            location: {},
            data: { id: 'anthropic', connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }, { type: 'credential', ...ACCOUNT_A }, { type: 'credential', ...ACCOUNT_B }] },
          })),
          connection: {
            active: vi.fn(async () => ({ type: 'credential', ...ACCOUNT_A })),
            resolve: vi.fn(async (connection) => ({ type: 'oauth', access: `token-${connection.id}`, refresh: 'refresh', expires: 0 })),
          },
        },
        credential: { activate: vi.fn(async () => undefined) },
      },
    };
  };

  const retryEvent = (type = 'provider.quota') => ({
    sessionID: 'ses_1',
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude-opus' },
    error: { type, message: 'usage limit', response: { body: '{}' }, retryAfterMs: 90_000 },
    attempt: 2,
    decision: { retry: false },
  });

  const withCallbackEnv = async (run) => {
    const saved = { url: process.env.OPENCHAMBER_AGENT_TOOL_URL, token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN };
    process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:4100/api/openchamber/agent-tool';
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'token';
    try {
      await run();
    } finally {
      for (const [key, value] of [['OPENCHAMBER_AGENT_TOOL_URL', saved.url], ['OPENCHAMBER_AGENT_TOOL_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.unstubAllGlobals();
    }
  };

  it('reports the failure with the stored accounts and activates the account the server names', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't1' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover');
      expect(init.headers.authorization).toBe('Bearer token');
      expect(JSON.parse(init.body)).toMatchObject({
        sessionID: 'ses_1',
        providerID: 'anthropic',
        modelID: 'claude-opus',
        error: { type: 'provider.quota', body: '{}', retryAfterMs: 90_000 },
        proposed: { retry: false },
        credentials: [ACCOUNT_A, ACCOUNT_B],
        activeCredentialID: ACCOUNT_A.id,
      });
      expect(ctx.credential.activate).toHaveBeenCalledWith({ credentialID: ACCOUNT_B.id });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
      const [settleUrl, settleInit] = fetchMock.mock.calls[1];
      expect(settleUrl).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover/settle');
      expect(JSON.parse(settleInit.body)).toEqual({ ticket: 't1', applied: true });
    });
  });

  it('reports a switch that failed and keeps OpenCode\'s decision', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    ctx.credential.activate.mockRejectedValueOnce(new Error('credential removed'));
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't2' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);
      expect(event.decision).toEqual({ retry: false });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ticket: 't2', applied: false });
    });
  });

  it('switches the session model when told to', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } }))));
      const event = retryEvent();
      await hooks.retry(event);
      expect(ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'openai', id: 'gpt-5.6' } });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
    });
  });

  it("keeps OpenCode's decision for other errors, a 'none' answer, or a failed call", async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'none' })));
      vi.stubGlobal('fetch', fetchMock);
      const other = retryEvent('provider.internal');
      await hooks.retry(other);
      expect(fetchMock).not.toHaveBeenCalled();

      await hooks.retry(retryEvent('provider.free-limit'));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).error.type).toBe('provider.free-limit');
      await hooks.retry(retryEvent('provider.model-budget-limit'));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).error.type).toBe('provider.model-budget-limit');
      await hooks.retry(retryEvent('provider.go-limit'));
      expect(JSON.parse(fetchMock.mock.calls[2][1].body).error.type).toBe('provider.go-limit');
      await hooks.retry(retryEvent('provider.chatgpt-limit'));
      expect(JSON.parse(fetchMock.mock.calls[3][1].body).error.type).toBe('provider.chatgpt-limit');

      const none = retryEvent();
      await hooks.retry(none);
      expect(none.decision).toEqual({ retry: false });

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const failed = retryEvent();
      await hooks.retry(failed);
      expect(failed.decision).toEqual({ retry: false });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
    });
  });

  it('waits the delay the server names instead of stopping', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'wait', delay: 3_600_000 }))));
      const event = retryEvent();
      await hooks.retry(event);
      expect(event.decision).toEqual({ retry: true, delay: 3_600_000 });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
    });
  });

  it('ends the turn without retrying when the server says a fixed session failed', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'fail' }))));
      const event = retryEvent();
      await hooks.retry(event);
      expect(event.decision).toEqual({ retry: false });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
      expect(ctx.session.switchModel).not.toHaveBeenCalled();
    });
  });

  it('activates the account the server names when a turn starts', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ activate: ACCOUNT_B.id })));
      vi.stubGlobal('fetch', fetchMock);
      await hooks.prompt({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'hi' }, delivery: 'queue' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover/session-account');
      expect(ctx.credential.activate).toHaveBeenCalledWith({ credentialID: ACCOUNT_B.id });
      // A server that names no account leaves the active one alone.
      ctx.credential.activate.mockClear();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ activate: null }))));
      await hooks.prompt({ sessionID: 'ses_1', messageID: 'msg_2', prompt: { text: 'hi' }, delivery: 'queue' });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
    });
  });

  it('attaches the captured anthropic headers of the 429 to the report', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'none' })));
      vi.stubGlobal('fetch', fetchMock);
      await hooks['http.response']({
        sessionID: 'ses_1',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-fable-5-2' },
        kind: 'primary',
        request: new Request('https://api.anthropic.com/v1/messages', { method: 'POST' }),
        response: new Response('{"type":"error"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-reset': String(Math.floor((NOW + 3_600_000) / 1000)),
            'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable',
          },
        }),
      });
      // A response of another provider or status is not captured.
      await hooks['http.response']({
        sessionID: 'ses_1',
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-5.6' },
        kind: 'primary',
        request: new Request('https://api.openai.com/v1/chat/completions', { method: 'POST' }),
        response: new Response('{}', { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected' } }),
      });
      await hooks.retry(retryEvent());
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.captured).toMatchObject({ status: 'rejected', claim: 'seven_day_fable' });
      expect(body.captured.resetAt).toBe(NOW + 3_600_000);
      // The capture is consumed by the report that followed it.
      await hooks.retry(retryEvent());
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).captured).toBeUndefined();
    });
  });

  it('sweeps each stored account plan usage after a switch settles', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async (url, init) => {
        if (String(url) === 'https://api.anthropic.com/api/oauth/usage') {
          return new Response(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }));
        }
        const body = init?.body ? JSON.parse(init.body) : {};
        if (String(url).endsWith('/limit-failover/usage')) return new Response(JSON.stringify({ stored: true }));
        return new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't9' }));
      });
      vi.stubGlobal('fetch', fetchMock);
      await hooks.retry(retryEvent());
      // The sweep runs after the switch settles, so wait for its report rather
      // than for a fixed delay.
      const deadline = Date.now() + 1_000;
      let post;
      while (Date.now() < deadline && post === undefined) {
        post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/limit-failover/usage'));
        if (post === undefined) await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      expect(post).toBeDefined();
      expect(JSON.parse(post[1].body).accounts).toHaveLength(2);
      expect(post[1].headers.authorization).toBe('Bearer token');
      // Each account's token reads only its own usage and is sent nowhere else.
      expect(JSON.stringify(JSON.parse(post[1].body))).not.toContain('token-');
    });
  });
});
