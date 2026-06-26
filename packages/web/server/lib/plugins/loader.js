import fs from 'fs';
import path from 'path';
import os from 'os';

export async function loadQuotaPlugins() {
  const dir = path.join(os.homedir(), '.config', 'openchamber', 'plugins', 'quota');
  const registry = {};
  if (!fs.existsSync(dir)) return registry;

  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
  } catch (err) {
    console.warn(`[openchamber:plugins] Failed to read ${dir}:`, err);
    return registry;
  }
  if (!files.length) return registry;

  const utils = await import('../quota/utils/index.js');
  const auth = await import('../opencode/auth.js');

  const ctx = {
    buildResult: utils.buildResult,
    toUsageWindow: utils.toUsageWindow,
    toNumber: utils.toNumber,
    toTimestamp: utils.toTimestamp,
    formatMoney: utils.formatMoney,
    readAuthFile: auth.readAuthFile,
    getAuthEntry: utils.getAuthEntry,
    normalizeAuthEntry: utils.normalizeAuthEntry,
  };

  for (const file of files) {
    try {
      const mod = await import(path.resolve(dir, file));
      const plugin = (mod.default || mod)(ctx);
      if (plugin?.providerId && plugin?.fetchQuota) {
        registry[plugin.providerId] = {
          providerId: plugin.providerId,
          providerName: plugin.providerName,
          isConfigured: plugin.isConfigured || (() => false),
          fetchQuota: plugin.fetchQuota,
        };
      } else {
        console.warn(`[openchamber:plugins] ${file} is missing required fields (providerId, fetchQuota), skipping`);
      }
    } catch (err) {
      console.error(`[openchamber:plugins] Failed to load ${file}:`, err);
    }
  }

  return registry;
}
