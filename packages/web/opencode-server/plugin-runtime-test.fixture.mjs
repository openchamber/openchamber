// Registers the plugin-runtime hooks from source in a child process and reports
// the `marker` export a plugin import produces. `args[2]` points at
// plugin-runtime.mjs, `args[3]` at the plugin entry to import.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const [runtimePath, pluginEntry, local] = process.argv.slice(2);

// Resolved before the stubs below take `@opencode/plugin` over.
const prepareSourceURL = new URL('../source.node.js', import.meta.resolve('@opencode/plugin')).href;

// The plugin SDK the server publishes comes from packages this source file
// cannot resolve here; the runtime only needs the specifiers to resolve before its own
// hooks take over.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@opencode/plugin') || specifier === '@opencode/schema/tool') {
      return { url: `stub:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@opencode/plugin' || url === 'stub:@opencode/plugin/effect') {
      return { format: 'module', source: 'export const Plugin = { define: (value) => value };', shortCircuit: true };
    }
    if (url === 'stub:@opencode/schema/tool') {
      return { format: 'module', source: 'export const Tool = { Error: class ToolError extends Error {} };', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

await import(pathToFileURL(runtimePath).href);

// With `local` as `args[4]`, import the entry through the pinned OpenCode loader for a
// local plugin (prepareSource in @opencode/plugin), which marks the entry and every module
// outside node_modules it reaches with its reload query. It registers its hook after the
// runtime, as the server does.
const entryURL = pathToFileURL(pluginEntry).href;
const loaded = local === 'local'
  ? await (await (await import(prepareSourceURL)).prepareSource(entryURL, () => {})).load()
  : await import(entryURL);
console.log(JSON.stringify({ marker: loaded.marker }));
