import { getFolderConfigPaths, getLayerError, readConfigLayer, readConfigLayers } from './config-files.js';
import type { OpenCodeConfigLayer } from './config-files.js';

/**
 * Every config file OpenCode 2 reads, lowest priority first, each with its
 * parsed content: the global files, `OPENCODE_CONFIG`, then the files found
 * walking up from the project folder (`getFolderConfigPaths`). Readers that
 * take an entry from the last file defining it, as OpenCode's MCP and model
 * route plugins do, use this list in place of `readConfigLayers`' single
 * project file and deep merge. `required` marks the global and
 * `OPENCODE_CONFIG` files, whose parse error a reader may surface; a broken
 * folder file carries its `error` and an empty config.
 */
export function readConfigSources(workingDirectory?: string | null) {
  const layers = readConfigLayers(workingDirectory);
  const { userPath, userOverridePath, customPath } = layers.paths;
  const required = (filePath: string, config: OpenCodeConfigLayer) => ({ path: filePath, config, error: getLayerError(layers, filePath), required: true });
  return [
    required(userPath, layers.userConfig),
    ...(userOverridePath ? [required(userOverridePath, layers.userOverrideConfig)] : []),
    ...(customPath ? [required(customPath, layers.customConfig)] : []),
    ...getFolderConfigPaths(workingDirectory).map((filePath) => ({ path: filePath, ...readConfigLayer(filePath), required: false })),
  ];
}
