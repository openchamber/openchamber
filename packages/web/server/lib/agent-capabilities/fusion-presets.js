import { OpenChamberControlError } from '../openchamber-control/error.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Fusion presets: curated model panels the user creates in
 * Settings → OpenChamber → Fusion. The fusion tool accepts preset names ONLY
 * (never raw model lists), so the main LLM cannot invoke arbitrary — or
 * expensive — models. Settings are the single persisted source of truth;
 * sanitization happens in the settings layer, this module only reads.
 */
export const listFusionPresets = (settings) => {
  const presets = Array.isArray(settings?.fusionPresets) ? settings.fusionPresets : [];
  const result = [];
  for (const entry of presets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = asNonEmptyString(entry.name);
    if (!name) continue;
    const models = Array.isArray(entry.models)
      ? entry.models.map(asNonEmptyString).filter(Boolean)
      : [];
    if (models.length < 2) continue;
    const description = asNonEmptyString(entry.description);
    result.push({
      name,
      models,
      ...(description ? { description } : {}),
    });
  }
  return result;
};

export const resolveFusionPreset = (name, settings) => {
  const presetName = asNonEmptyString(name);
  if (!presetName) {
    throw new OpenChamberControlError('preset is required', 400);
  }
  const preset = listFusionPresets(settings).find((entry) => entry.name === presetName);
  if (!preset) {
    throw new OpenChamberControlError(
      `Unknown fusion preset '${presetName}' — create it in Settings → OpenChamber → Fusion`,
      400,
    );
  }
  return preset;
};
