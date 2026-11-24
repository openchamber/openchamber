// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
import { readFileSync, statSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as PromiseSdk from '@opencode/plugin';
import * as EffectSdk from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';

const SDK_EXPORTS = ['Agent', 'Command', 'Connection', 'Credential', 'Integration', 'Model', 'Plugin', 'Provider', 'Reference', 'Skill'];

const pick = (sdk) => Object.fromEntries(SDK_EXPORTS.map((name) => [name, sdk[name]]));

globalThis[Symbol.for('opencode.plugin.v2.promise')] = pick(PromiseSdk);
globalThis[Symbol.for('opencode.plugin.v2.effect')] = { ...pick(EffectSdk), Tool: { Error: Tool.Error } };

const sdkModule = (key, label) => `const sdk = globalThis[Symbol.for(${JSON.stringify(key)})]
if (!sdk) throw new Error(${JSON.stringify(`OpenCode ${label} plugin SDK is unavailable`)})
${SDK_EXPORTS.map((name) => `export const ${name} = sdk.${name}`).join('\n')}`;

const defineModule = (key, label) => `const sdk = globalThis[Symbol.for(${JSON.stringify(key)})]
if (!sdk) throw new Error(${JSON.stringify(`OpenCode ${label} plugin SDK is unavailable`)})
export const define = sdk.Plugin.define`;

const PROMISE = 'opencode.plugin.v2.promise';
const EFFECT = 'opencode.plugin.v2.effect';

const sources = {
  'opencode:plugin-v2': sdkModule(PROMISE, 'Promise'),
  'opencode:plugin-promise-plugin': defineModule(PROMISE, 'Promise'),
  'opencode:plugin-promise-tool': 'export {}',
  'opencode:plugin-v2-effect': sdkModule(EFFECT, 'Effect'),
  'opencode:plugin-v2-effect-plugin': defineModule(EFFECT, 'Effect'),
  'opencode:plugin-v2-effect-tool': `const sdk = globalThis[Symbol.for(${JSON.stringify(EFFECT)})]
if (!sdk) throw new Error("OpenCode Effect plugin SDK is unavailable")
export const Error = sdk.Tool.Error`,
};

const specifiers = {
  '@opencode/plugin': 'opencode:plugin-v2',
  '@opencode/plugin/promise/plugin': 'opencode:plugin-promise-plugin',
  '@opencode/plugin/promise/tool': 'opencode:plugin-promise-tool',
  '@opencode/plugin/effect': 'opencode:plugin-v2-effect',
  '@opencode/plugin/effect/plugin': 'opencode:plugin-v2-effect-plugin',
  '@opencode/plugin/effect/tool': 'opencode:plugin-v2-effect-tool',
};

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts']);

const TYPESCRIPT_MODE = (() => {
  try {
    stripTypeScriptTypes('enum Marker {}', { mode: 'transform' });
    return 'transform';
  } catch {
    return 'strip';
  }
})();

const installedTypeScript = (url) => {
  if (!url.startsWith('file:')) return null;
  const filename = fileURLToPath(url);
  if (!TYPESCRIPT_EXTENSIONS.has(path.extname(filename))) return null;
  return filename.split(path.sep).includes('node_modules') ? filename : null;
};

// external: https://bun.com/docs/runtime/module-resolution Bun's order for these suffixes inside node_modules, as Bun 1.4.4 resolves them
const RESOLVED_EXTENSIONS = ['.mjs', '.mts', '.js', '.cjs', '.ts', '.json'];

const UNRESOLVED_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

const isFile = (filename) => statSync(filename, { throwIfNoEntry: false })?.isFile() === true;

const resolvePluginImport = (specifier, context, error) => {
  if (!UNRESOLVED_CODES.has(error?.code)) return null;
  if (context.conditions?.includes('require')) return null;
  if (!context.parentURL || !installedTypeScript(context.parentURL)) return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (path.extname(specifier)) return null;
  const target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  const namesDirectory = specifier.endsWith('/');
  const files = namesDirectory ? [] : RESOLVED_EXTENSIONS.map((extension) => `${target}${extension}`);
  const found = files.concat(RESOLVED_EXTENSIONS.map((extension) => path.join(target, `index${extension}`))).find(isFile);
  return found ? pathToFileURL(found).href : null;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = specifiers[specifier];
    if (url) return { url, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const pluginImport = resolvePluginImport(specifier, context, error);
      if (pluginImport) return nextResolve(pluginImport, context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const source = sources[url];
    if (source) return { format: 'module', source, shortCircuit: true };
    const installed = installedTypeScript(url);
    if (installed) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(installed, 'utf8'), { mode: TYPESCRIPT_MODE }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
