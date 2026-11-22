import * as vscode from 'vscode';

type MachineSettingKey = 'apiUrl' | 'opencodeBinary';

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

export function readMachineSetting(key: MachineSettingKey): string {
  const config = vscode.workspace.getConfiguration('openchamber');
  if (vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) {
    return '';
  }
  return config.get<string>(key) || '';
}
