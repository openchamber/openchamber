const BUILT_IN_CONTEXT_PANEL_MODES = [
  'diff',
  'walkthrough',
  'file',
  'context',
  'plan',
  'chat',
  'browser',
  'git',
  'pr',
  'linear',
  'notes',
  'terminal',
] as const;

export type BuiltInContextPanelMode = (typeof BUILT_IN_CONTEXT_PANEL_MODES)[number];
export type PluginContextPanelMode = `plugin:${string}`;
export type ContextPanelMode = BuiltInContextPanelMode | PluginContextPanelMode;

const PLUGIN_MODE = /^plugin:[a-z][a-z0-9-]*$/;

const BUILT_IN_MODE_SET = new Set<string>(BUILT_IN_CONTEXT_PANEL_MODES);

export const isPluginContextPanelMode = (mode: string): mode is PluginContextPanelMode => {
  return PLUGIN_MODE.test(mode);
};

export const isContextPanelMode = (mode: string): mode is ContextPanelMode => {
  return BUILT_IN_MODE_SET.has(mode) || isPluginContextPanelMode(mode);
};

export const pluginIdFromMode = (mode: PluginContextPanelMode): string => mode.slice('plugin:'.length);

export const pluginModeFromId = (id: string): PluginContextPanelMode => `plugin:${id}`;
