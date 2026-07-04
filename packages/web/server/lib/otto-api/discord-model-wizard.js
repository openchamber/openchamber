import crypto from 'node:crypto';
import {
  WIZARD_TTL_MS,
  PAGE_SIZE,
  PREV_VALUE,
  NEXT_VALUE,
  buildPagedOptions,
  stringSelect,
  buttonRow,
  botHashFor,
  createWizardStore,
} from './discord-wizard-shared.js';

/**
 * Interactive `/model` wizard for the Discord gateway listener.
 *
 * Flow:
 *   /model → (shows the current model + thinking-effort)
 *          → pick provider (⭐ Favourites pseudo-provider first when the UI has
 *            any favourite models)
 *          → pick model
 *          → pick thinking-effort (only when the model exposes reasoning
 *            variants; skipped otherwise)
 *          → pick scope (this conversation / this project / whole system)
 *          → confirmation + a "Send last message" button that replays the
 *            conversation's last prompt under the freshly-chosen model.
 *
 * Discord string-select menus are capped at 25 options, so provider / model
 * lists are paged via the shared helpers. Wizard state is keyed by a short
 * random hash embedded in each component's `custom_id` and expires after
 * {@link WIZARD_TTL_MS}.
 *
 * Kept free of gateway/WebSocket plumbing so it can be unit-tested in
 * isolation; the listener just delegates the matching interactions here.
 */

// Re-exported for callers/tests that import the paging helpers from here.
export { WIZARD_TTL_MS, PAGE_SIZE, buildPagedOptions };

const PROVIDER_PREFIX = 'otto-model-provider:';
const MODEL_PREFIX = 'otto-model-model:';
const EFFORT_PREFIX = 'otto-model-effort:';
const SCOPE_PREFIX = 'otto-model-scope:';
const RESEND_PREFIX = 'otto-model-resend:';

const FAVORITES_ID = '__otto_favorites';
const EFFORT_NONE = '__otto_effort_none';

/** Normalise a provider's `models` (array or map) into a flat array. */
export function modelsOf(provider) {
  if (!provider || !provider.models) return [];
  return Array.isArray(provider.models) ? provider.models : Object.values(provider.models);
}

/** Compact token count: 200000 → "200K", 1500000 → "1.5M". */
function formatTokensCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) {
    const v = value / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const v = value / 1_000;
    return `${Number.isInteger(v) ? v : Math.round(v)}K`;
  }
  return String(value);
}

/** Per-million-token USD price: 3 → "$3", 0.15 → "$0.15", 0 → "$0". */
function formatCostPerMillion(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return '$0';
  const rounded = Number(value.toFixed(2));
  return `$${rounded}`;
}

/**
 * Build the Discord select-option description for a model: its context window
 * and (when available) per-million-token input/output price — e.g.
 * `200K ctx · in $3/out $15 /Mtok`. Returns '' when the model exposes no
 * usable metadata. Replaces the old `release_date` formatting that showed a
 * confusing bare date under every model name.
 */
export function formatModelMeta(model) {
  if (!model || typeof model !== 'object') return '';
  const parts = [];
  const ctx = formatTokensCompact(model?.limit?.context);
  if (ctx) parts.push(`${ctx} ctx`);
  const input = formatCostPerMillion(model?.cost?.input);
  const output = formatCostPerMillion(model?.cost?.output);
  if (input && output) parts.push(`in ${input}/out ${output} /Mtok`);
  else if (input) parts.push(`in ${input} /Mtok`);
  else if (output) parts.push(`out ${output} /Mtok`);
  return parts.join(' · ');
}

/** Normalise a model's reasoning `variants` (array or map) into a flat array of keys. */
export function variantsOf(model) {
  const v = model?.variants;
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'object') return Object.keys(v);
  return [];
}

export function createDiscordModelWizard({ restCall, bridge }) {
  const wizards = createWizardStore();
  const setWizard = wizards.set;
  const getWizard = wizards.get;
  const delWizard = wizards.del;

  /** Send an interaction callback using the bot token. */
  function respond(token, interaction, data) {
    return restCall(
      token,
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      data,
    );
  }

  function expired(token, interaction) {
    return respond(token, interaction, {
      type: 7,
      data: { content: 'Selection expired. Please run /model again.', flags: 64, components: [] },
    });
  }

  /** Is this a component interaction this wizard owns? */
  function ownsComponent(customId) {
    return (
      typeof customId === 'string' &&
      (customId.startsWith(PROVIDER_PREFIX) ||
        customId.startsWith(MODEL_PREFIX) ||
        customId.startsWith(EFFORT_PREFIX) ||
        customId.startsWith(SCOPE_PREFIX) ||
        customId.startsWith(RESEND_PREFIX))
    );
  }

  function modelVariants(wizard, providerId, modelId) {
    const provider = wizard.providersById?.get(providerId);
    if (!provider) return [];
    const model = modelsOf(provider).find((m) => (m.id ?? m.name) === modelId);
    return variantsOf(model);
  }

  /** Stable `provider/model` key used to match the UI's hidden-model set. */
  function modelKey(providerId, model) {
    const id = model?.id ?? model?.name;
    return id ? `${providerId}/${id}` : null;
  }

  /**
   * A provider's models minus the ones the user hid in the OpenChamber UI, so
   * the Discord `/model` list matches what the UI shows instead of exposing
   * every model the provider advertises.
   */
  function visibleModelsOf(provider, hiddenSet) {
    const all = modelsOf(provider);
    if (!hiddenSet || hiddenSet.size === 0) return all;
    return all.filter((m) => !hiddenSet.has(modelKey(provider.id, m)));
  }

  /** Find a model object across all providers (for enriching favourite rows). */
  function findModel(providersById, providerId, modelId) {
    const provider = providersById?.get(providerId);
    if (!provider) return null;
    return modelsOf(provider).find((m) => (m.id ?? m.name) === modelId) ?? null;
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function providerOptions(entries) {
    return entries.map((e) => ({
      label: (e.name ?? e.id).slice(0, 100),
      value: e.id,
      description: `${e.count} model${e.count === 1 ? '' : 's'}`.slice(0, 100),
    }));
  }

  function renderProviderSelect(hash, entries, page) {
    const { options } = buildPagedOptions(providerOptions(entries), page);
    return stringSelect(`${PROVIDER_PREFIX}${hash}`, options, 'Select a provider');
  }

  function modelOptions(models) {
    return models.map((m) => ({
      label: (m.label ?? m.name ?? m.id ?? String(m)).slice(0, 100),
      value: m.value ?? m.id ?? m.name ?? String(m),
      // Show context window + pricing under the model name (falling back to an
      // explicit `description` when one is provided, e.g. favourites).
      description: ((m.description || formatModelMeta(m)) || ' ').slice(0, 100),
    }));
  }

  function renderModelSelect(hash, models, page) {
    const { options } = buildPagedOptions(modelOptions(models), page);
    return stringSelect(`${MODEL_PREFIX}${hash}`, options, 'Select a model');
  }

  function renderEffortSelect(hash, variants) {
    const options = [
      { label: 'Default (no thinking effort)', value: EFFORT_NONE, description: 'Let the model decide' },
      ...variants.map((v) => ({ label: v, value: v, description: `Thinking effort: ${v}`.slice(0, 100) })),
    ];
    return stringSelect(`${EFFORT_PREFIX}${hash}`, options, 'Select thinking effort');
  }

  function renderScopeSelect(hash) {
    const options = [
      { label: 'This conversation', value: 'conversation', description: 'Override for this thread/channel only' },
      { label: 'This project', value: 'project', description: "Default for this conversation's project" },
      { label: 'Whole system (default)', value: 'global', description: 'OpenChamber default model everywhere' },
    ];
    return stringSelect(`${SCOPE_PREFIX}${hash}`, options, 'Apply to…');
  }

  function currentLine(info) {
    if (!info?.model) return 'Current model: _OpenCode default_';
    const effort = info.variant ? ` · effort \`${info.variant}\`` : '';
    const src = info.source ? ` _(${info.source})_` : '';
    return `Current model: \`${info.model}\`${effort}${src}`;
  }

  // ── /model command entrypoint ──────────────────────────────────────────────
  async function start(state, interaction) {
    const hash = crypto.randomBytes(6).toString('hex');

    let providerData;
    try {
      providerData = await bridge?.fetchProviders?.();
    } catch {
      providerData = null;
    }

    if (!providerData || !Array.isArray(providerData.all) || providerData.all.length === 0) {
      // No structured provider data — fall back to the text `/model` command.
      const result = await bridge?.runCommand?.({
        type: 'discord',
        token: state.token,
        channelId: interaction.channel_id,
        commandName: 'model',
      });
      await respond(state.token, interaction, {
        type: 4,
        data: { content: result?.reply?.slice(0, 2000) ?? '_(no providers configured)_', flags: 64 },
      });
      return;
    }

    const all = providerData.all;
    const providersById = new Map(all.map((p) => [p.id, p]));
    const connectedSet = new Set(Array.isArray(providerData.connected) ? providerData.connected : []);
    // Prefer providers with credentials, but never render an empty menu: if
    // nothing is flagged connected, show everything OpenCode knows about.
    const connected = all.filter((p) => connectedSet.has(p.id));
    const realProviders = connected.length > 0 ? connected : all;

    const rawFavorites = (await bridge?.getFavoriteModels?.().catch(() => [])) ?? [];
    const hiddenList = (await bridge?.getHiddenModels?.().catch(() => [])) ?? [];
    const hiddenSet = new Set(
      hiddenList.map(({ providerID, modelID }) => `${providerID}/${modelID}`),
    );

    // Favourites mirror the UI: only models that still exist on a live provider
    // and are NOT hidden. Prevents Discord from listing favourites the UI has
    // dropped or hidden.
    const favorites = rawFavorites.filter(({ providerID, modelID }) => {
      const key = `${providerID}/${modelID}`;
      if (hiddenSet.has(key)) return false;
      return Boolean(findModel(providersById, providerID, modelID));
    });

    // Provider menu entries: ⭐ Favourites first (when any), then real providers
    // that have at least one visible (non-hidden) model.
    const entries = [];
    if (favorites.length > 0) {
      entries.push({ id: FAVORITES_ID, name: '⭐ Favourites', count: favorites.length });
    }
    for (const p of realProviders) {
      const count = visibleModelsOf(p, hiddenSet).length;
      if (count === 0) continue;
      entries.push({ id: p.id, name: p.name ?? p.id, count });
    }

    const current = (await bridge?.getSurfaceModelInfo?.({
      type: 'discord',
      token: state.token,
      channelId: interaction.channel_id,
      threadId: null,
    }).catch(() => null)) ?? null;

    const user = interaction.member?.user ?? interaction.user ?? {};
    setWizard(hash, {
      token: state.token,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      appId: interaction.application_id,
      from: { id: user.id, username: user.username, firstName: user.global_name ?? null },
      providersById,
      favorites,
      hiddenSet,
      entries,
      providerPage: 0,
      modelPage: 0,
    });

    await respond(state.token, interaction, {
      type: 4,
      data: {
        content: `**Set model**\n${currentLine(current)}\n\nSelect a provider:`,
        flags: 64,
        components: [renderProviderSelect(hash, entries, 0)],
      },
    });
  }

  // ── component interactions ─────────────────────────────────────────────────
  async function handleComponent(state, interaction, customId) {
    const token = state?.token;
    if (customId.startsWith(PROVIDER_PREFIX)) {
      return onProviderSelect(token, interaction, customId.slice(PROVIDER_PREFIX.length));
    }
    if (customId.startsWith(MODEL_PREFIX)) {
      return onModelSelect(token, interaction, customId.slice(MODEL_PREFIX.length));
    }
    if (customId.startsWith(EFFORT_PREFIX)) {
      return onEffortSelect(token, interaction, customId.slice(EFFORT_PREFIX.length));
    }
    if (customId.startsWith(SCOPE_PREFIX)) {
      return onScopeSelect(token, interaction, customId.slice(SCOPE_PREFIX.length));
    }
    if (customId.startsWith(RESEND_PREFIX)) {
      return onResend(token, interaction, customId.slice(RESEND_PREFIX.length));
    }
  }

  async function onProviderSelect(token, interaction, hash) {
    const wizard = getWizard(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;

    if (value === PREV_VALUE || value === NEXT_VALUE) {
      wizard.providerPage = (wizard.providerPage ?? 0) + (value === NEXT_VALUE ? 1 : -1);
      setWizard(hash, wizard);
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: '**Set model**\nSelect a provider:',
          flags: 64,
          components: [renderProviderSelect(hash, wizard.entries, wizard.providerPage)],
        },
      });
      return;
    }

    let models;
    if (value === FAVORITES_ID) {
      wizard.isFavorites = true;
      wizard.providerId = FAVORITES_ID;
      wizard.providerName = '⭐ Favourites';
      // Favourite entries carry their full `provider/model` ref as the value so
      // a single menu can mix models from different providers.
      models = wizard.favorites.map(({ providerID, modelID }) => {
        const model = findModel(wizard.providersById, providerID, modelID);
        const meta = model ? formatModelMeta(model) : '';
        return {
          value: `${providerID}/${modelID}`,
          label: modelID,
          // Prefer context/pricing, fall back to the provider id for context.
          description: meta || providerID,
        };
      });
    } else {
      const provider = wizard.providersById?.get(value);
      if (!provider) return;
      wizard.isFavorites = false;
      wizard.providerId = provider.id;
      wizard.providerName = provider.name ?? provider.id;
      models = visibleModelsOf(provider, wizard.hiddenSet);
    }

    if (!models || models.length === 0) {
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: `Provider **${wizard.providerName}** has no models available.`,
          flags: 64,
          components: [],
        },
      });
      return;
    }

    wizard.models = models;
    wizard.modelPage = 0;
    setWizard(hash, wizard);

    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `**Set model**\nProvider: **${wizard.providerName}**\nSelect a model:`,
        flags: 64,
        components: [renderModelSelect(hash, models, 0)],
      },
    });
  }

  async function onModelSelect(token, interaction, hash) {
    const wizard = getWizard(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;

    if (value === PREV_VALUE || value === NEXT_VALUE) {
      wizard.modelPage = (wizard.modelPage ?? 0) + (value === NEXT_VALUE ? 1 : -1);
      setWizard(hash, wizard);
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: `**Set model**\nProvider: **${wizard.providerName}**\nSelect a model:`,
          flags: 64,
          components: [renderModelSelect(hash, wizard.models, wizard.modelPage)],
        },
      });
      return;
    }

    // Favourites already carry the full `provider/model` ref; real providers
    // contribute the bare model id.
    const modelId = wizard.isFavorites ? value : `${wizard.providerId}/${value}`;
    const slash = modelId.indexOf('/');
    const providerId = modelId.slice(0, slash);
    const localId = modelId.slice(slash + 1);
    wizard.selectedModelId = modelId;
    wizard.selectedProviderId = providerId;
    wizard.selectedModelLocal = localId;
    setWizard(hash, wizard);

    const variants = modelVariants(wizard, providerId, localId);
    if (variants.length > 0) {
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: `**Set model**\nModel: \`${modelId}\`\nSelect thinking effort:`,
          flags: 64,
          components: [renderEffortSelect(hash, variants)],
        },
      });
      return;
    }

    // No reasoning variants — go straight to the scope picker.
    wizard.selectedVariant = null;
    await promptScope(wizard, hash, interaction);
  }

  async function onEffortSelect(token, interaction, hash) {
    const wizard = getWizard(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;
    wizard.selectedVariant = value === EFFORT_NONE ? null : value;
    await promptScope(wizard, hash, interaction);
  }

  async function promptScope(wizard, hash, interaction) {
    setWizard(hash, wizard);
    const effortLine = wizard.selectedVariant ? ` · effort \`${wizard.selectedVariant}\`` : '';
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `**Set model**\nModel: \`${wizard.selectedModelId}\`${effortLine}\nApply to:`,
        flags: 64,
        components: [renderScopeSelect(hash)],
      },
    });
  }

  async function onScopeSelect(token, interaction, hash) {
    const wizard = getWizard(hash);
    if (!wizard) return expired(token, interaction);
    const scope = interaction.data?.values?.[0];
    if (!scope) return;

    const model = wizard.selectedModelId;
    const variant = wizard.selectedVariant ?? null;
    let scopeLabel = 'this conversation';

    try {
      if (scope === 'global') {
        const r = await bridge?.setGlobalDefaultModel?.({ model, variant });
        scopeLabel = r?.ok === false ? 'this conversation (system default is read-only)' : 'the whole system';
        if (r?.ok === false) {
          bridge?.setSurfaceModel?.({ type: 'discord', token: wizard.token, channelId: wizard.channelId, threadId: null, model, variant });
        }
      } else if (scope === 'project') {
        // Project scope needs the channel to resolve to a project; otherwise
        // fall back to a conversation override so the choice still takes effect.
        const binding = bridge?.store?.lookup?.({
          type: 'discord',
          botTokenHash: botHashFor(wizard.token),
          targetKey: String(wizard.channelId),
        });
        if (binding?.projectPath) {
          bridge?.store?.setProjectDefaults?.({
            projectPath: binding.projectPath,
            projectLabel: binding.projectLabel,
            modelDefault: model,
            variantDefault: variant,
          });
          scopeLabel = `project *${binding.projectLabel ?? binding.projectPath}*`;
        } else {
          bridge?.setSurfaceModel?.({ type: 'discord', token: wizard.token, channelId: wizard.channelId, threadId: null, model, variant });
          scopeLabel = 'this conversation (no project bound yet)';
        }
      } else {
        bridge?.setSurfaceModel?.({ type: 'discord', token: wizard.token, channelId: wizard.channelId, threadId: null, model, variant });
        scopeLabel = 'this conversation';
      }
    } catch {
      // best-effort — the reply still reflects the user's choice
    }

    wizard.modelDisplay = model;
    setWizard(hash, wizard);

    const effortLine = variant ? `\nThinking effort: \`${variant}\`` : '';
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content:
          `✓ Model for ${scopeLabel}:\n\`${model}\`${effortLine}\n\n` +
          'Press **Send last message** to re-run your previous message with this model.',
        flags: 64,
        components: [
          buttonRow([
            { label: '▶ Send last message', customId: `${RESEND_PREFIX}${hash}`, style: 3 },
          ]),
        ],
      },
    });
  }

  async function onResend(token, interaction, hash) {
    const wizard = getWizard(hash);
    if (!wizard) return expired(token, interaction);

    // Ack immediately and strip the button so it can't be double-pressed.
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `▶ Re-sending your last message under \`${wizard.modelDisplay}\`…`,
        flags: 64,
        components: [],
      },
    });
    delWizard(hash);

    let result = null;
    try {
      result = await bridge?.resendLastMessage?.({
        type: 'discord',
        token: wizard.token,
        channelId: wizard.channelId,
        threadId: null,
        from: wizard.from,
      });
    } catch (err) {
      result = { ok: false, error: err?.message ?? 'send failed' };
    }

    if (!result?.ok) {
      await restCall(
        wizard.token,
        'PATCH',
        `/webhooks/${wizard.appId}/${interaction.token}/messages/@original`,
        {
          content: `⚠ Could not re-send: ${result?.error ?? 'no previous message found'}.`,
          components: [],
        },
      ).catch(() => {});
    }
  }

  return { start, handleComponent, ownsComponent };
}
