import tls from 'node:tls';
import { parseArgs, usage } from './args.mjs';

// eslint-disable-next-line no-undef
const OPENCODE_VERSION = __OPENCODE_SERVER_VERSION__;

const BUN_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

const isOpenCodeHost = (host = '') => host === 'opencode.ai' || host.endsWith('.opencode.ai');

const hasExplicitCipherList = () =>
  /--tls[-_]cipher[-_]list/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' '));

const offerBunCiphersToOpenCode = () => {
  if (hasExplicitCipherList()) return;
  const connect = tls.connect;
  tls.connect = function (options, ...rest) {
    const toOpenCode = options?.ciphers === undefined && isOpenCodeHost(options?.servername ?? options?.host);
    return connect.call(this, toOpenCode ? { ...options, ciphers: BUN_CIPHERS } : options, ...rest);
  };
};

const main = async () => {
  delete process.env.ELECTRON_RUN_AS_NODE;
  offerBunCiphersToOpenCode();

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
