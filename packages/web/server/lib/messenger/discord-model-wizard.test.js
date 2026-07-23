import { describe, it, expect } from 'vitest';
import {
  buildPagedOptions,
  modelsOf,
  formatModelMeta,
  formatModelModalities,
  primaryModalityEmoji,
  PAGE_SIZE,
  PAGE_SIZE_WITH_BUTTON_NAV,
  createDiscordModelWizard,
} from './discord-model-wizard.js';

describe('formatModelMeta', () => {
  it('renders context window + input/output pricing', () => {
    expect(
      formatModelMeta({ limit: { context: 200000 }, cost: { input: 3, output: 15 } }),
    ).toBe('200K ctx · in $3/out $15 /Mtok');
  });

  it('renders a compact millions context', () => {
    expect(formatModelMeta({ limit: { context: 1000000 } })).toBe('1M ctx');
    expect(formatModelMeta({ limit: { context: 1500000 } })).toBe('1.5M ctx');
  });

  it('shows context only when pricing is absent', () => {
    expect(formatModelMeta({ limit: { context: 128000 } })).toBe('128K ctx');
  });

  it('handles fractional prices and only input cost', () => {
    expect(formatModelMeta({ limit: { context: 8000 }, cost: { input: 0.15 } })).toBe(
      '8K ctx · in $0.15 /Mtok',
    );
  });

  it('prefixes modality icons before context and pricing', () => {
    expect(
      formatModelMeta({
        modalities: { input: ['text', 'image'] },
        limit: { context: 200000 },
        cost: { input: 3, output: 15 },
      }),
    ).toBe('📝🖼️ · 200K ctx · in $3/out $15 /Mtok');
  });

  it('never renders a date and returns empty when no metadata exists', () => {
    expect(formatModelMeta({ release_date: '2024-01-01' })).toBe('');
    expect(formatModelMeta({})).toBe('');
    expect(formatModelMeta(null)).toBe('');
  });
});

describe('formatModelModalities / primaryModalityEmoji', () => {
  it('renders ordered modality emoji for known inputs', () => {
    expect(formatModelModalities({ modalities: { input: ['pdf', 'text', 'image'] } })).toBe('📝🖼️📄');
    expect(formatModelModalities({ modalities: { input: ['audio', 'video'] } })).toBe('🎬🔊');
  });

  it('falls back to image when only the legacy attachment flag is set', () => {
    expect(formatModelModalities({ attachment: true })).toBe('🖼️');
    expect(primaryModalityEmoji({ attachment: true })).toBe('🖼️');
  });

  it('prefers image/video/audio/pdf over text for the select badge', () => {
    expect(primaryModalityEmoji({ modalities: { input: ['text', 'image'] } })).toBe('🖼️');
    expect(primaryModalityEmoji({ modalities: { input: ['text'] } })).toBe('📝');
    expect(primaryModalityEmoji({})).toBe(null);
  });
});

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

  it('can fill all 25 select slots when in-select nav is disabled', () => {
    const { options, totalPages, pageSize } = buildPagedOptions(items, 0, { includeNav: false });
    expect(pageSize).toBe(PAGE_SIZE_WITH_BUTTON_NAV);
    expect(totalPages).toBe(Math.ceil(60 / PAGE_SIZE_WITH_BUTTON_NAV));
    expect(options.length).toBe(PAGE_SIZE_WITH_BUTTON_NAV);
    expect(options.every((o) => o.value.startsWith('v'))).toBe(true);
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
function makeHarness(providers, { favorites = [], hidden = [], current = null, binding = null } = {}) {
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
    getHiddenModels: async () => hidden,
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
function lastSelectOptions(call) {
  const select = call.body?.data?.components?.[0]?.components?.[0];
  return select?.options ?? [];
}
function lastCustomId(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.custom_id;
}
function buttonLabels(call) {
  const rows = call.body?.data?.components ?? [];
  return rows
    .flatMap((row) => row.components ?? [])
    .filter((c) => c.type === 2)
    .map((c) => c.label);
}
function buttonCustomIdByLabel(call, labelIncludes) {
  const rows = call.body?.data?.components ?? [];
  for (const row of rows) {
    for (const c of row.components ?? []) {
      if (c.type === 2 && String(c.label ?? '').includes(labelIncludes)) {
        return c.custom_id;
      }
    }
  }
  return null;
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

    // pick the provider → first page of models (25) + Back / More buttons
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, provCustomId);
    const modelPage0 = calls.at(-1);
    const modelCustomId = lastCustomId(modelPage0);
    expect(lastSelectValues(modelPage0)).toContain('m0');
    expect(lastSelectValues(modelPage0)).toHaveLength(PAGE_SIZE_WITH_BUTTON_NAV);
    expect(lastSelectValues(modelPage0)).not.toContain(`m${PAGE_SIZE_WITH_BUTTON_NAV}`);
    expect(buttonLabels(modelPage0)).toEqual(expect.arrayContaining(['← Back']));
    expect(buttonLabels(modelPage0).some((l) => l.includes('More ▶'))).toBe(true);
    const nextCustomId = buttonCustomIdByLabel(modelPage0, 'More ▶');
    expect(wizard.ownsComponent(nextCustomId)).toBe(true);

    // page forward via button → second page reveals models past the first 25,
    // and Back remains available while paginating
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: {} }, nextCustomId);
    const modelPage1 = calls.at(-1);
    expect(lastSelectValues(modelPage1)).toContain(`m${PAGE_SIZE_WITH_BUTTON_NAV}`);
    expect(buttonLabels(modelPage1)).toEqual(expect.arrayContaining(['← Back']));
    expect(buttonLabels(modelPage1).some((l) => l.includes('Page'))).toBe(true);

    // pick a model with no variants → scope picker (conversation/project/system)
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: { values: ['m30'] } }, modelCustomId);
    const scopeSelect = calls.at(-1);
    expect(lastSelectValues(scopeSelect)).toEqual(['conversation', 'project', 'global']);
    expect(buttonLabels(scopeSelect)).toContain('← Back');
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

  it('lets users step back from model/effort/scope, including while paginating models', async () => {
    const withVariants = [
      {
        id: 'gpt',
        name: 'GPT',
        models: Array.from({ length: 40 }, (_, i) => ({
          id: `m${i}`,
          name: `m${i}`,
          variants: i === 30 ? { low: {}, high: {} } : undefined,
        })),
      },
    ];
    const { wizard, calls } = makeHarness(withVariants);
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provCustomId = lastCustomId(calls.at(-1));

    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['gpt'] } }, provCustomId);
    const modelPage0 = calls.at(-1);
    const nextCustomId = buttonCustomIdByLabel(modelPage0, 'More ▶');
    await wizard.handleComponent(state, { id: 'i3', token: 't3', data: {} }, nextCustomId);
    expect(calls.at(-1).body.data.content).toContain('Select a model');

    // Back from a later model page returns to the provider menu (root has no Back).
    const backFromModels = buttonCustomIdByLabel(calls.at(-1), '← Back');
    await wizard.handleComponent(state, { id: 'i4', token: 't4', data: {} }, backFromModels);
    expect(calls.at(-1).body.data.content).toContain('Select a provider');
    expect(buttonLabels(calls.at(-1))).not.toContain('← Back');

    // Re-enter provider → model → effort → scope, then walk back step by step.
    await wizard.handleComponent(state, { id: 'i5', token: 't5', data: { values: ['gpt'] } }, provCustomId);
    const modelCustomId = lastCustomId(calls.at(-1));
    const nextAgain = buttonCustomIdByLabel(calls.at(-1), 'More ▶');
    await wizard.handleComponent(state, { id: 'i6', token: 't6', data: {} }, nextAgain);
    await wizard.handleComponent(state, { id: 'i7', token: 't7', data: { values: ['m30'] } }, modelCustomId);
    expect(calls.at(-1).body.data.content).toContain('thinking effort');
    expect(buttonLabels(calls.at(-1))).toContain('← Back');

    await wizard.handleComponent(
      state,
      { id: 'i8', token: 't8', data: { values: ['high'] } },
      lastCustomId(calls.at(-1)),
    );
    expect(calls.at(-1).body.data.content).toContain('Apply to');
    expect(buttonLabels(calls.at(-1))).toContain('← Back');

    await wizard.handleComponent(
      state,
      { id: 'i9', token: 't9', data: {} },
      buttonCustomIdByLabel(calls.at(-1), '← Back'),
    );
    expect(calls.at(-1).body.data.content).toContain('thinking effort');

    await wizard.handleComponent(
      state,
      { id: 'i10', token: 't10', data: {} },
      buttonCustomIdByLabel(calls.at(-1), '← Back'),
    );
    expect(calls.at(-1).body.data.content).toContain('Select a model');
    expect(buttonLabels(calls.at(-1))).toEqual(expect.arrayContaining(['← Back']));
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
    expect(lastSelectValues(effortSelect)).toEqual(['__openchamber_agent_effort_none', 'low', 'high']);

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
    expect(lastSelectValues(provSelect)).toContain('__openchamber_agent_favorites');
    const provCustomId = lastCustomId(provSelect);

    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['__openchamber_agent_favorites'] } }, provCustomId);
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

  it('hides models the UI hid and shows modalities/context/pricing in the description', async () => {
    const richProviders = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'sonnet',
            name: 'Sonnet',
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 200000 },
            cost: { input: 3, output: 15 },
          },
          { id: 'legacy', name: 'Legacy' },
        ],
      },
    ];
    const { wizard, calls } = makeHarness(richProviders, {
      hidden: [{ providerID: 'anthropic', modelID: 'legacy' }],
    });
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    // Provider count reflects only visible models (1, not 2).
    const provOpts = lastSelectOptions(calls.at(-1));
    expect(provOpts[0].description).toContain('1 model');
    const provCustomId = lastCustomId(calls.at(-1));

    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, provCustomId);
    const modelOpts = lastSelectOptions(calls.at(-1));
    // The hidden model is gone; the visible one carries modalities + context + pricing.
    expect(modelOpts.map((o) => o.value)).toEqual(['sonnet']);
    expect(modelOpts[0].description).toBe('📝🖼️ · 200K ctx · in $3/out $15 /Mtok');
    expect(modelOpts[0].emoji).toEqual({ name: '🖼️' });
  });

  it('drops a favourite that the UI hid', async () => {
    const { wizard, calls } = makeHarness(providers, {
      favorites: [
        { providerID: 'anthropic', modelID: 'm5' },
        { providerID: 'anthropic', modelID: 'm6' },
      ],
      hidden: [{ providerID: 'anthropic', modelID: 'm6' }],
    });
    await wizard.start(state, { id: 'i1', token: 't1', channel_id: 'chan', application_id: 'app' });
    const provCustomId = lastCustomId(calls.at(-1));
    await wizard.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['__openchamber_agent_favorites'] } }, provCustomId);
    // Only the non-hidden favourite survives.
    expect(lastSelectValues(calls.at(-1))).toEqual(['anthropic/m5']);
  });
});
