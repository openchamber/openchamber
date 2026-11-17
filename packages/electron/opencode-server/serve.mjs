import { parseArgs, usage } from './args.mjs';

// eslint-disable-next-line no-undef
const OPENCODE_VERSION = __OPENCODE_SERVER_VERSION__;

const main = async () => {
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
