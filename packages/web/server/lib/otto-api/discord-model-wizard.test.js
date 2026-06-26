import { describe, it, expect } from 'vitest';
import {
  buildPagedOptions,
  modelsOf,
  PAGE_SIZE,
  createDiscordModelWizard,
} from './discord-model-wizard.js';

describe('buildPagedOptions', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    label: `item-${i}`,
    value: `v${i}`,
  }));

  it('shows only a next-nav entry on the first page', () => {
    const { options, page, totalPages } = buildPagedOptions(items, 0);
    expect(page).toBe(0);
    expect(totalPages).toBe(Math.ceil(60 / PAGE_SIZE));
    expect(options.length).toBe(PAGE_SIZE + 1); // 23 items + "More ▶"
    expect(options[0].value).toBe('v0');
    expect(options.at(-1).label).toBe('More ▶');
    expect(options.some((o) => o.label === '◀ Previous')).toBe(false);
  });

  it('shows both nav entries on a middle page', () => {
    const { options } = buildPagedOptions(items, 1);
    expect(options[0].label).toBe('◀ Previous');
    expect(options.at(-1).label).toBe('More ▶');
    // First real item on page 1 is index PAGE_SIZE
    expect(options[1].value).toBe(`v${PAGE_SIZE}`);
  });

  it('shows only a previous-nav entry on the last page', () => {
    const last = Math.ceil(60 / PAGE_SIZE) - 1;
    const { options } = buildPagedOptions(items, last);
    expect(options[0].label).toBe('◀ Previous');
    expect(options.some((o) => o.label === 'More ▶')).toBe(false);
  });

  it('clamps out-of-range pages and never exceeds Discord 25-option cap', () => {
    const { page } = buildPagedOptions(items, 999);
    expect(page).toBe(Math.ceil(60 / PAGE_SIZE) - 1);
    for (let p = 0; p < 5; p++) {
      const { options } = buildPagedOptions(items, p);
      expect(options.length).toBeLessThanOrEqual(25);
    }
  });

  it('handles a single page with no nav entries', () => {
    const { options, totalPages } = buildPagedOptions(items.slice(0, 5), 0);
    expect(totalPages).toBe(1);
    expect(options.length).toBe(5);
    expect(options.some((o) => o.label.includes('▶') || o.label.includes('◀'))).toBe(false);
  });
});

describe('modelsOf', () => {
  it('reads an array of models', () => {
    expect(modelsOf({ models: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
  });
  it('reads a map of models', () => {
    expect(modelsOf({ models: { a: { id: 'a' }, b: { id: 'b' } } })).toHaveLength(2);
  });
  it('returns [] for missing models', () => {
    expect(modelsOf({})).toEqual([]);
    expect(modelsOf(null)).toEqual([]);
  });
});

/** A restCall recorder + a bridge stub. */
function makeHarness(providers, { favorites = [], current = null, binding = null } = {}) {
  const calls = [];
  const restCall = async (token, method, path, body) => {
    calls.push({ token, method, path, body });
    return { ok: true, status: 200, body: {} };
  };
  const setModels = [];
  const projectDefaults = [];
  const globalDefaults = [];
  const resends = [];
  const bridge = {
    fetchProviders: async () => ({ all: providers, connected: providers.map((p) => p.id) }),
    getFavoriteModels: async () => favorites,
    getSurfaceModelInfo: async () => current,
    setSurfaceModel: (o) => setModels.push(o),
    setGlobalDefaultModel: async (o) => {
      globalDefaults.push(o);
      return { ok: true };
    },
    store: {
      lookup: () => binding,
      setProjectDefaults: (o) => projectDefaults.push(o),
    },
    resendLastMessage: async (o) => {
      resends.push(o);
      return { ok: true, text: 'previous message' };
    },
  };
  const wizard = createDiscordModelWizard({ restCall, bridge });
  return { wizard, calls, setModels, projectDefaults, globalDefaults, resends };
}

function lastSelectValues(call) {
  const select = call.body?.data?.components?.[0]?.components?.[0];
  return select?.options?.map((o) => o.value) ?? [];
}
function lastCustomId(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.custom_id;
}

describe('createDiscordModelWizard flow', () => {
  const state = { token: 'bot-token' };
  const manyModels = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `m${i}` }));
  const providers = [{ id: 'anthropic', name: 'Anthropic', models: manyModels }];

  it('shows the current model, paginates models, and applies a conversation override', async () => {
    const { wizard, calls, setModels } = makeHarness(providers, {
      current: { model: 'anthropic/m1', variant: null, source: 'this conversation' },
    });

    // /model → provider select shown with the current model line
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const providerSelect = calls.at(-1);
    expect(providerSelect.body.data.content).toContain('anthropic/m1');
    const provCustomId = lastCustomId(providerSelect);
    expect(wizard.ownsComponent(provCustomId)).toBe(true);

    // pick the provider → first page of models (23 + "More ▶")
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, provCustomId);
    const modelPage0 = calls.at(-1);
    const modelCustomId = lastCustomId(modelPage0);
    expect(lastSelectValues(modelPage0)).toContain('m0');
    expect(lastSelectValues(modelPage0)).toContain('__otto_next');
    expect(lastSelectValues(modelPage0)).not.toContain(`m${PAGE_SIZE}`);

    // page forward → second page reveals models past the first 23
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['__otto_next'] } }, modelCustomId);
    expect(lastSelectValues(calls.at(-1))).toContain(`m${PAGE_SIZE}`);
    expect(lastSelectValues(calls.at(-1))).toContain('__otto_prev');

    // pick a model with no variants → scope picker (conversation/project/system)
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['m30'] } }, modelCustomId);
    const scopeSelect = calls.at(-1);
    expect(lastSelectValues(scopeSelect)).toEqual(['conversation', 'project', 'global']);
    const scopeCustomId = lastCustomId(scopeSelect);

    // choose "this conversation" → surface override stored + resend button
    await wizard.handleComponent(state, { id: 'i5', token: 't5', data: { values: ['conversation'] } }, scopeCustomId);
    expect(setModels).toHaveLength(1);
    expect(setModels[0]).toMatchObject({ type: 'discord', channelId: 'chan', model: 'anthropic/m30', variant: null });
    const final = calls.at(-1);
    expect(final.body.data.content).toContain('anthropic/m30');
    const button = final.body.data.components[0].components[0];
    expect(button.type).toBe(2);
    expect(wizard.ownsComponent(button.custom_id)).toBe(true);
  });

  it('asks for thinking effort when the model has variants, then scope', async () => {
    const withVariants = [
      { id: 'gpt', name: 'GPT', models: [{ id: 'o3', name: 'o3', variants: { low: {}, high: {} } }] },
    ];
    const { wizard, calls, setModels } = makeHarness(withVariants);
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['gpt'] } }, provCustomId);
    const modelCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['o3'] } }, modelCustomId);
    const effortSelect = calls.at(-1);
    expect(effortSelect.body.data.content).toContain('thinking effort');
    const effortCustomId = lastCustomId(effortSelect);
    expect(lastSelectValues(effortSelect)).toEqual(['__otto_effort_none', 'low', 'high']);

    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['high'] } }, effortCustomId);
    const scopeCustomId = lastCustomId(calls.at(-1));
    expect(lastSelectValues(calls.at(-1))).toEqual(['conversation', 'project', 'global']);

    await wizard.handleComponent(state, { id: 'i5', token: 't5', data: { values: ['conversation'] } }, scopeCustomId);
    expect(setModels).toHaveLength(1);
    expect(setModels[0]).toMatchObject({ model: 'gpt/o3', variant: 'high' });
  });

  it('project scope writes a project default when a project is bound', async () => {
    const { wizard, calls, projectDefaults } = makeHarness(providers, {
      binding: { projectPath: '/proj', projectLabel: 'Proj' },
    });
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, provCustomId);
    const modelCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['m0'] } }, modelCustomId);
    const scopeCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['project'] } }, scopeCustomId);
    expect(projectDefaults).toEqual([
      { projectPath: '/proj', projectLabel: 'Proj', modelDefault: 'anthropic/m0', variantDefault: null },
    ]);
  });

  it('whole-system scope writes the OpenChamber default model', async () => {
    const { wizard, calls, globalDefaults } = makeHarness(providers);
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, provCustomId);
    const modelCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['m0'] } }, modelCustomId);
    const scopeCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['global'] } }, scopeCustomId);
    expect(globalDefaults).toEqual([{ model: 'anthropic/m0', variant: null }]);
    expect(calls.at(-1).body.data.content).toContain('whole system');
  });

  it('adds a ⭐ Favourites pseudo-provider and replays the last message via the button', async () => {
    const { wizard, calls, setModels, resends } = makeHarness(providers, {
      favorites: [{ providerID: 'anthropic', modelID: 'm5' }],
    });
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provSelect = calls.at(-1);
    expect(lastSelectValues(provSelect)).toContain('__otto_favorites');
    const provCustomId = lastCustomId(provSelect);

    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['__otto_favorites'] } }, provCustomId);
    const modelSelect = calls.at(-1);
    expect(lastSelectValues(modelSelect)).toEqual(['anthropic/m5']);
    const modelCustomId = lastCustomId(modelSelect);

    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['anthropic/m5'] } }, modelCustomId);
    const scopeCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['conversation'] } }, scopeCustomId);
    expect(setModels[0]).toMatchObject({ model: 'anthropic/m5', variant: null });
    const buttonCustomId = lastCustomId(calls.at(-1));

    await wizard.handleComponent(state, { id: 'i5', token: 't5', data: {} }, buttonCustomId);
    expect(resends).toHaveLength(1);
    expect(resends[0]).toMatchObject({ type: 'discord', channelId: 'chan' });
  });
});
