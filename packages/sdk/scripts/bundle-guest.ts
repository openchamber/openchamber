#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const usage = 'Usage: openchamber-guest-bundle [--node] <entry.ts> <outfile.js>';

const args = process.argv.slice(2);
const nodeTarget = args.includes('--node');
const [entry, outfile] = args.filter((arg) => arg !== '--node');
if (!entry || !outfile) {
  console.error(usage);
  process.exit(1);
}

const bun = globalThis.Bun;
if (!bun?.build) {
  console.error('This bundle command needs Bun.');
  process.exit(1);
}

// A panel runs in a sandboxed iframe that cannot load ESM, so it gets a
// browser IIFE. A local service runs under Node, so `--node` keeps ESM and
// leaves the Node built-ins external.
const result = await bun.build({
  entrypoints: [resolve(entry)],
  format: nodeTarget ? 'esm' : 'iife',
  target: nodeTarget ? 'node' : 'browser',
  minify: !nodeTarget,
  write: false,
});

if (!result.success) {
  const message = result.logs.map((log) => log.message).join('\n');
  console.error(message || 'Guest script build failed');
  process.exit(1);
}

const artifact = result.outputs[0];
if (!artifact) {
  console.error('Guest script build produced no output');
  process.exit(1);
}

await writeFile(resolve(outfile), await artifact.text());
