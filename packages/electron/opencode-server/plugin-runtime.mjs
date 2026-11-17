// external: https://github.com/anomalyco/opencode/blob/v2.3.0/packages/cli/vite.node.config.ts
import { registerHooks } from 'node:module';
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = specifiers[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = sources[url];
    return source ? { format: 'module', source, shortCircuit: true } : nextLoad(url, context);
  },
});
