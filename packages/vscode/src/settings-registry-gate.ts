// Gate for the bridge's settings write path. The generated registry snapshot
// (`settings-registry.json`, produced from the UI package's settings registry)
// names every key OpenChamber persists; anything else the webview sends is
// dropped here so the shared settings file never grows keys the rest of the
// product does not know about.
//
// Kept free of `vscode` imports so it is unit-tested directly.
import registrySnapshot from './settings-registry.json';

type SettingsRegistryGateField = {
  scope: string;
  perSurface?: boolean;
  computed?: boolean;
  secret?: boolean;
  local?: boolean;
  owner?: string;
};

export type SettingsRegistryGateFields = Record<string, SettingsRegistryGateField>;

export const SETTINGS_REGISTRY_FIELDS: SettingsRegistryGateFields = registrySnapshot.fields;

/**
 * A key is persistable through the bridge only when the registry lists it as a
 * stored, shared field: not computed at read time, not local to one webview's
 * store, and not owned by the desktop shell (which keeps its own values).
 */
const isPersistableField = (field: SettingsRegistryGateField | undefined): boolean => {
  if (!field) return false;
  if (field.computed === true) return false;
  if (field.local === true) return false;
  if (field.owner === 'desktop-shell') return false;
  return true;
};

export const filterPersistableSettingsChanges = (
  changes: Record<string, unknown>,
  fields: SettingsRegistryGateFields = SETTINGS_REGISTRY_FIELDS,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (!isPersistableField(fields[key])) continue;
    next[key] = value;
  }
  return next;
};

/** Drop the keys the registry marks `secret`: accepted on write, never handed back to a webview. */
export const withoutSecretSettings = (
  settings: Record<string, unknown>,
  fields: SettingsRegistryGateFields = SETTINGS_REGISTRY_FIELDS,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (fields[key]?.secret === true) continue;
    next[key] = value;
  }
  return next;
};
