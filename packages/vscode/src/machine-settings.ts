import * as vscode from 'vscode';

type MachineSettingKey = 'apiUrl' | 'opencodeBinary';

// `globalLocalValue` and `globalRemoteValue` are missing from `@types/vscode`
// and from older VS Code builds such as 1.95.
type MachineSettingLevels = {
  globalLocalValue?: string;
  globalRemoteValue?: string;
  workspaceValue?: string;
};

function comesOnlyFromLocalUserSettings(levels: MachineSettingLevels | undefined): boolean {
  return levels?.globalLocalValue !== undefined
    && levels.globalRemoteValue === undefined
    && levels.workspaceValue === undefined;
}

/**
 * Reads a setting that describes one machine. While a remote window starts,
 * VS Code still reports the local User value of a `machine-overridable` setting,
 * so that value is treated as unset there.
 */
export function readMachineSetting(key: MachineSettingKey): string {
  const config = vscode.workspace.getConfiguration('openchamber');
  if (vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) {
    return '';
  }
  return config.get<string>(key) || '';
}
