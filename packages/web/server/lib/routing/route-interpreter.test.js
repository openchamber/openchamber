import { describe, expect, it, vi } from 'vitest';

import {
  answerQuestion,
  choiceQuestions,
  fromChoices,
  groundChoices,
  interpret,
  keywords,
  toOverrides,
} from './route-interpreter.js';

const now = new Date(2026, 9, 8, 9, 0).getTime();
const context = {
  providers: ['anthropic', 'openai', 'google'],
  models: [
    { id: 'claude-opus-4-5', providerID: 'anthropic' },
    { id: 'claude-opus-4-6', providerID: 'anthropic' },
    { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
    { id: 'gpt-5', providerID: 'openai' },
    { id: 'gemini-2.5-pro', providerID: 'google' },
  ],
  now,
};

describe('keywords stage', () => {
  it('decides with certainty when the provider and the duration are both named', () => {
    const result = keywords('stop using anthropic for the rest of the day', context);
    expect(result).toMatchObject({ status: 'decided', confidence: 'certain' });
    expect(result.drafts[0]).toMatchObject({ action: 'avoid', providers: ['anthropic'], models: [] });
    expect(result.drafts[0].until).toBeGreaterThan(now);
  });

  it('asks which Claude the user means when Claude is named without a provider', () => {
    const result = keywords("don't use claude anymore today", context);
    expect(result).toMatchObject({ status: 'clarify', key: 'claude' });
    expect(result.options.map((option) => option.label)).toHaveLength(2);
  });

  it('answers a clarifying question from what the user has learned', () => {
    const result = keywords("don't use claude anymore today", context, {
      claude: 'Anthropic provider only',
    });
    expect(result).toMatchObject({ status: 'decided', origin: { key: 'claude', option: 'Anthropic provider only' } });
    expect(result.drafts[0].providers).toEqual(['anthropic']);
  });

  it('prefers the newest model of a named family on each provider', () => {
    const result = keywords('use opus', context);
    expect(result).toMatchObject({ status: 'decided', confidence: 'tentative' });
    expect(result.drafts).toEqual([
      expect.objectContaining({ action: 'prefer', providers: ['anthropic'], models: ['claude-opus-4-6'], factor: 3 }),
    ]);
  });

  it('leaves sentences without an action or a target to the smart stages', () => {
    expect(keywords('make it nicer', context)).toMatchObject({ status: 'unknown' });
  });
});

describe('keywords stage: named models and kinds of model', () => {
  const copilot = {
    providers: ['github-copilot', 'anthropic'],
    models: [
      { id: 'gemini-4-carbon', providerID: 'github-copilot' },
      { id: 'gemini-3-flash', providerID: 'github-copilot' },
      { id: 'claude-opus-5.5', providerID: 'github-copilot' },
      { id: 'gpt-6-luna', providerID: 'github-copilot' },
      { id: 'claude-opus-5.5', providerID: 'anthropic' },
    ],
    now,
  };

  it('scopes "provider/model#variant" to exactly that model, ignoring the variant', () => {
    const result = keywords('prefer github-copilot/gemini-4-carbon#high', copilot);
    expect(result).toMatchObject({ status: 'decided' });
    expect(result.drafts).toEqual([
      expect.objectContaining({ action: 'prefer', providers: ['github-copilot'], models: ['gemini-4-carbon'], factor: 3 }),
    ]);
  });

  it('scopes a bare model id to every provider that serves it', () => {
    const result = keywords('switch back to claude-opus-5.5 for 2 hours', copilot);
    expect(result).toMatchObject({ status: 'decided', confidence: 'certain' });
    expect(result.drafts).toEqual([
      expect.objectContaining({ action: 'prefer', providers: ['github-copilot'], models: ['claude-opus-5.5'] }),
      expect.objectContaining({ action: 'prefer', providers: ['anthropic'], models: ['claude-opus-5.5'] }),
    ]);
    expect(result.drafts[0].until).toBe(now + 2 * 60 * 60 * 1000);
  });

  it('reads a word shared with model names as a kind of model across providers', () => {
    const result = keywords('prefer gemini models', copilot);
    expect(result).toMatchObject({ status: 'decided', confidence: 'tentative' });
    expect(result.drafts).toEqual([
      expect.objectContaining({ action: 'prefer', providers: ['github-copilot'], models: ['gemini-4-carbon', 'gemini-3-flash'] }),
    ]);
  });

  it('narrows a kind to the provider the sentence names', () => {
    const result = keywords('avoid flash on github-copilot today', copilot);
    expect(result.drafts).toEqual([
      expect.objectContaining({ action: 'avoid', providers: ['github-copilot'], models: ['gemini-3-flash'] }),
    ]);
  });

  it('keeps a provider whole when only its own name or alias is said', () => {
    const result = keywords('use gpt more', { ...context });
    expect(result.drafts).toEqual([expect.objectContaining({ providers: ['openai'], models: [] })]);
  });

  it('does not invent a provider that is not configured', () => {
    expect(keywords('prefer openai', copilot)).toMatchObject({ status: 'unknown' });
  });

  it('refuses an unavailable exact reference without widening it to a provider or family', async () => {
    const sentence = 'prefer github-copilot/claude-opus-missing#max';
    expect(keywords(sentence, copilot)).toMatchObject({ status: 'unknown' });
    const external = vi.fn();
    expect(await interpret({ text: sentence, context: copilot, stages: { external } }))
      .toMatchObject({ status: 'unknown' });
    expect(external).not.toHaveBeenCalled();
  });

  it('treats a word no model shares as no target', () => {
    expect(keywords('prefer cheap models', copilot)).toMatchObject({ status: 'unknown' });
  });
});

describe('interpret', () => {
  const recorder = (result) => {
    const stage = vi.fn(async () => result);
    return stage;
  };

  it('never asks a smart stage when the keywords can decide or ask', async () => {
    const local = recorder(undefined);
    const external = recorder(undefined);
    await interpret({
      text: "don't use claude anymore today",
      context,
      stages: { local, external },
    });
    const decided = await interpret({
      text: 'stop using anthropic for the rest of the day',
      context,
      stages: { local, external },
    });
    expect(decided.status).toBe('decided');
    expect(local).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it('returns the keyword question when no smart stage decides', async () => {
    const result = await interpret({
      text: "don't use claude anymore today",
      context,
      stages: { local: recorder(undefined), external: recorder(undefined) },
    });
    expect(result).toMatchObject({ status: 'clarify', key: 'claude' });
  });

  it('uses the local stage first and falls through a failing stage to the external one', async () => {
    const local = vi.fn(async () => {
      throw new Error('model not loaded');
    });
    const external = recorder({ status: 'decided', stage: 'smart', confidence: 'tentative', drafts: [], summary: 'x' });
    const result = await interpret({
      text: 'lean on the cheaper ones for now',
      context,
      stages: { local, external },
    });
    expect(local).toHaveBeenCalledTimes(1);
    expect(external).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'decided', summary: 'x' });
  });

  it('skips stages the settings turn off', async () => {
    const local = recorder({ status: 'decided', stage: 'smart', confidence: 'tentative', drafts: [], summary: 'x' });
    const result = await interpret({
      text: 'lean on the cheaper ones for now',
      context,
      toggles: { keywords: true, local: false, external: true },
      stages: { local, external: recorder(undefined) },
    });
    expect(local).not.toHaveBeenCalled();
    expect(result.status).toBe('unknown');
  });
});

describe('groundChoices', () => {
  it('takes the provider from the sentence rather than from the model', () => {
    const grounded = groundChoices(
      { action: 'prefer', provider: 'anthropic', family: 'opus', duration: 'hour' },
      'use gemini more',
      context,
    );
    expect(grounded).toEqual({ action: 'prefer', duration: 'hour', provider: 'google', family: undefined });
  });

  it('drops a provider and family the sentence does not name', () => {
    const decision = fromChoices(
      groundChoices({ action: 'prefer', provider: 'anthropic', family: 'opus', duration: 'none' }, 'make the sidebar nicer', context),
      { text: 'make the sidebar nicer', context, confidence: 'tentative' },
    );
    expect(decision).toMatchObject({ status: 'unknown' });
  });
});

describe('fromChoices', () => {
  it('needs a provider to avoid a family', () => {
    const decision = fromChoices(
      { action: 'avoid', provider: 'none', family: 'sonnet', duration: 'none' },
      { text: 'avoid sonnet', context, confidence: 'tentative' },
    );
    expect(decision.status).toBe('unknown');
  });

  it('turns a named provider and duration into one tentative rule', () => {
    const decision = fromChoices(
      { action: 'avoid', provider: 'openai', family: 'none', duration: 'hour' },
      { text: 'stop using openai for an hour', context, confidence: 'tentative' },
    );
    expect(decision).toMatchObject({ status: 'decided', confidence: 'tentative' });
    expect(decision.drafts[0]).toMatchObject({ action: 'avoid', providers: ['openai'], models: [] });
    expect(decision.drafts[0].until).toBe(now + 60 * 60 * 1000);
  });
});

describe('answerQuestion and toOverrides', () => {
  it('applies a picked option with its origin, and rejects a label that is not one', () => {
    const question = keywords("don't use claude anymore today", context);
    const decision = answerQuestion(question, 'Every Claude model, any provider');
    expect(decision).toMatchObject({ status: 'decided', origin: { key: 'claude', option: 'Every Claude model, any provider' } });
    expect(decision.drafts[0].models).toEqual(['*claude*']);
    expect(answerQuestion(question, 'Something else')).toBeNull();
  });

  it('builds override records that carry the origin of their question', () => {
    const question = keywords("don't use claude anymore today", context);
    const decision = answerQuestion(question, 'Anthropic provider only');
    const [item] = toOverrides(decision.drafts, { source: 'interpreter', now, summary: decision.summary, origin: decision.origin });
    expect(item).toMatchObject({
      action: 'avoid',
      providers: ['anthropic'],
      source: 'interpreter',
      createdAt: now,
      origin: { key: 'claude', option: 'Anthropic provider only' },
    });
    expect(item.id).toMatch(/^interpreter:/);
  });

  it('offers the duration and the provider choices the smart stages answer', () => {
    const questions = choiceQuestions(context);
    expect(Object.keys(questions)).toEqual(['action', 'provider', 'family', 'duration']);
    expect(Object.keys(questions.provider.criteria)).toEqual(expect.arrayContaining(['anthropic', 'openai', 'google', 'none']));
  });
});
