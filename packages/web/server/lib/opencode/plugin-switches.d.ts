export type PluginSwitchRead =
  | { ok: true; resources: string[] }
  | { ok: false; error: Error };

export type PluginSwitchState = 'on' | 'off' | 'unavailable' | 'unreadable' | 'overridden';

export type PluginDenial = { action: 'integration.use'; resource: string; effect: 'deny' };

export type PluginSwitchStore = {
  filePath: string;
  read(): PluginSwitchRead;
  set(resource: string, enabled: boolean): { changed: boolean };
  denials(): PluginDenial[];
};

export function createPluginSwitchStore(input: { filePath: string }): PluginSwitchStore;
export function pluginPolicyResource(spec: string, sourcePath?: string): string | null;
export function isPluginDenialOverridden(resource: string, configs: readonly unknown[]): boolean;
export function pluginSwitchState(read: PluginSwitchRead, resource: string, configsAhead: readonly unknown[]): PluginSwitchState;
