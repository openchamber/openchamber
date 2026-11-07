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
  /** Whether the user's environment owns `OPENCODE_CONFIG`; the managed file is ours only when it does not. */
  userOwnsConfig: boolean;
};

/**
 * Apply the switch denials to the environment the managed OpenCode child is
 * launched with. Without a user-owned `OPENCODE_CONFIG`, OpenChamber owns the
 * extra layer and OpenCode watches the file. When the user owns that variable,
 * the denials merge into `OPENCODE_CONFIG_CONTENT`, which the running child
 * only reads at launch.
 *
 * Throws when the denials cannot be established or merged, before anything is
 * written: a launch without them would load the plugins the user switched off,
 * and an empty file would turn them back on in the running child.
 */
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
