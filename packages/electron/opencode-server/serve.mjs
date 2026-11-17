// The desktop's OpenCode server: `opencode serve` built from OpenCode's npm packages and run on Electron's
// own Node (ELECTRON_RUN_AS_NODE). It answers the command line the managed lifecycle gives every OpenCode
// binary (`--version`, `serve [--stdio] --hostname --port`), so `lib/opencode/lifecycle.js` starts, probes
// and stops it like any other. See DOCUMENTATION.md in this folder.
//
// This entry stays small: `--version` answers without loading OpenCode, and the native paths are set
// before any OpenCode module evaluates, because the bundle runs every statically imported chunk first.

import { parseArgs, usage } from './args.mjs';

// The bundler defines this as the pinned @opencode/server version (scripts/prepare-opencode-server.mjs);
// this file runs only as that bundle.
// eslint-disable-next-line no-undef
const OPENCODE_VERSION = __OPENCODE_SERVER_VERSION__;

const main = async () => {
  // Electron runs this file as plain Node only because of this variable. Tools, MCP servers and agent
  // shells inherit the environment, and an Electron app they start would otherwise come up as Node too.
  delete process.env.ELECTRON_RUN_AS_NODE;

  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    process.exit(2);
  }
  if (options.command === 'version') {
    process.stdout.write(`${OPENCODE_VERSION}\n`);
    return;
  }
  if (options.command === 'unsupported') {
    process.stderr.write(`OpenChamber's built-in OpenCode only runs the server. Install the OpenCode CLI for other commands.\n${usage}\n`);
    process.exit(2);
  }

  const { configureAssets } = await import('./assets.mjs');
  configureAssets(new URL('./assets/', import.meta.url));
  const { run } = await import('./server.mjs');
  run({ ...options, version: OPENCODE_VERSION });
};

await main();
