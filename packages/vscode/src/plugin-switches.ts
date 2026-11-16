import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../../web/server/lib/opencode/atomic-write.js';
import { appendManagedPolicies } from '../../web/server/lib/opencode/managed-plugin-config.js';
import { createPluginSwitchStore, type PluginSwitchRead } from '../../web/server/lib/opencode/plugin-switches.js';

type PluginSwitchApplyResult = { updated: boolean; requiresManualRestart: boolean };

const switchFilePath = (directory: string): string => path.join(directory, 'plugin-switches.json');

const switchStore = (directory: string) => createPluginSwitchStore({ filePath: switchFilePath(directory) });

export const readPluginSwitches = (directory: string): PluginSwitchRead => switchStore(directory).read();

export const setPluginSwitch = (directory: string, resource: string, enabled: boolean): { changed: boolean } => (
  switchStore(directory).set(resource, enabled)
);

type PluginSwitchApplyOptions = {
  userOwnsConfig: boolean;
};

export const applyPluginSwitchPolicies = (
  env: NodeJS.ProcessEnv,
  directory: string,
  { userOwnsConfig }: PluginSwitchApplyOptions,
): PluginSwitchApplyResult => {
  const policies = switchStore(directory).denials();
  if (userOwnsConfig) {
    if (policies.length > 0) {
      env.OPENCODE_CONFIG_CONTENT = appendManagedPolicies(env.OPENCODE_CONFIG_CONTENT, policies);
    }
    return { updated: false, requiresManualRestart: true };
  }

  const filePath = path.join(directory, 'opencode.managed.json');
  fs.mkdirSync(directory, { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify({ policies }, null, 2)}\n`);
  env.OPENCODE_CONFIG = filePath;
  return { updated: true, requiresManualRestart: false };
};
