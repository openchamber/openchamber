import fs from 'node:fs';
import path from 'node:path';
import { atomicWritePrivateJson, safeErrorMessage } from './identity.js';
import { isWorkspacePluginEntry } from './plugin-identity.js';
import { buildPluginOptions, readWorkspaceSettings } from './policy.js';

/**
 * Persisted Secure Workspace settings and the OpenCode plugin registration are one
 * transaction. They are written together and must agree afterwards, so every mutation
 * goes through a prepared journal that can restore the exact prior field family and
 * plugin entries — after a caught failure, or after an interrupted process.
 */
export function createSettingsTransaction({
  openchamberDataDir,
  readSettingsFromDiskMigrated,
  restoreSettingsFields,
  listPluginEntries,
  createPluginEntry,
  deletePluginEntry,
  resolvedWorkspacePluginSpec,
}) {
  const settingsTransactionFile = path.join(openchamberDataDir, 'workspace-settings-transaction.json');

  const workspacePluginEntries = (pluginSpec) => listPluginEntries(null).filter((entry) => isWorkspacePluginEntry(entry, pluginSpec));

  const restoreWorkspaceConfiguration = async ({ previousSettings, previousEntries, pluginSpec }) => {
    await restoreSettingsFields(previousSettings, 'secureWorkspaces');
    for (const entry of workspacePluginEntries(pluginSpec)) deletePluginEntry(entry.id, null);
    for (const entry of previousEntries) {
      createPluginEntry({ spec: entry.spec, scope: entry.scope, options: entry.options }, null);
    }
  };

  const clearSettingsTransaction = async () => {
    await fs.promises.rm(settingsTransactionFile, { force: true });
    try {
      const directoryHandle = await fs.promises.open(path.dirname(settingsTransactionFile), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch {
      // Directory fsync is not supported by every platform/filesystem.
    }
  };

  const recoverSettingsTransaction = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(settingsTransactionFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    let transaction;
    try {
      transaction = JSON.parse(raw);
    } catch {
      throw new Error('Secure Workspace settings transaction journal is corrupt');
    }
    if (!transaction || transaction.version !== 1 || transaction.phase !== 'prepared') {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    if (!transaction.previousSettings || typeof transaction.previousSettings !== 'object' || !Array.isArray(transaction.previousEntries) || typeof transaction.pluginSpec !== 'string' || !transaction.pluginSpec) {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    if (Object.keys(transaction.previousSettings).some((key) => !key.startsWith('secureWorkspaces'))
      || transaction.previousEntries.some((entry) => !entry || typeof entry !== 'object' || !isWorkspacePluginEntry(entry, transaction.pluginSpec))) {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    await restoreWorkspaceConfiguration(transaction);
    await clearSettingsTransaction();
  };

  const canonicalJson = (value) => JSON.stringify(value, (key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  ));

  /**
   * Converges the OpenCode plugin registration with what persisted settings say it must
   * be. Registering a missing entry repairs an interrupted save or a restored profile,
   * where the persisted flag and the registration contradict each other. Rewriting an
   * entry whose options differ repairs a quieter drift: the entry materializes the
   * policy at the moment settings were last saved, so a policy default that moved since
   * — a repinned image digest — never reached OpenCode, and every new workspace kept
   * being built from the superseded image. Nothing else rewrites the entry, so without
   * this the two copies drift apart forever.
   */
  const reconcilePluginRegistration = async () => {
    const persisted = await readSettingsFromDiskMigrated();
    const settings = readWorkspaceSettings(persisted);
    if (!settings.enabled) return;
    const pluginSpec = resolvedWorkspacePluginSpec();
    const entries = workspacePluginEntries(pluginSpec);
    const options = buildPluginOptions(settings, { requireComplete: true });
    if (entries.length === 0) {
      createPluginEntry({ spec: pluginSpec, scope: 'user', options }, null);
      console.log('[Secure Workspaces] Registered the workspace plugin, which enabled settings expected and OpenCode did not have');
      return;
    }
    if (entries.length === 1
      && entries[0].spec === pluginSpec
      && entries[0].scope === 'user'
      && canonicalJson(entries[0].options ?? null) === canonicalJson(options)) return;
    const transaction = {
      version: 1,
      phase: 'prepared',
      pluginSpec,
      previousSettings: Object.fromEntries(Object.entries(persisted).filter(([key]) => key.startsWith('secureWorkspaces'))),
      previousEntries: entries.map((entry) => ({ spec: entry.spec, scope: entry.scope, options: entry.options })),
    };
    await atomicWritePrivateJson(settingsTransactionFile, transaction);
    try {
      for (const entry of entries) deletePluginEntry(entry.id, null);
      createPluginEntry({ spec: pluginSpec, scope: 'user', options }, null);
      await clearSettingsTransaction();
      console.log('[Secure Workspaces] Rewrote the workspace plugin registration, whose options had fallen behind the current policy');
    } catch (error) {
      await restoreWorkspaceConfiguration(transaction);
      await clearSettingsTransaction();
      throw error;
    }
  };

  /**
   * Recovery runs before anything reads workspace state, and a configuration that cannot
   * be repaired is reported rather than hidden: readiness then describes the provider as
   * unconfigured, which is the honest answer.
   */
  const settingsRecoveryPromise = recoverSettingsTransaction()
    .then(() => reconcilePluginRegistration())
    .catch((error) => {
      console.warn('[Secure Workspaces] Could not reconcile plugin registration:', safeErrorMessage(error, 'reconciliation failed'));
    });

  return {
    settingsTransactionFile,
    settingsRecoveryPromise,
    workspacePluginEntries,
    restoreWorkspaceConfiguration,
    clearSettingsTransaction,
  };
}
