import fs from 'node:fs';
import path from 'node:path';

export function installedWebCli(directory) {
  const root = path.join(directory, 'node_modules', '@openchamber', 'web');
  let cli = path.join(root, 'bin', 'cli.js');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    cli = path.resolve(root, manifest.bin?.openchamber || 'bin/cli.js');
  } catch {
    // A partial legacy install may still have a CLI that can stop its server.
  }
  return fs.existsSync(cli) ? cli : '';
}

// The remote host has Node but not this checkout's development scripts.
// Serialize the same resolver so local and remote deployment follow one rule.
export const installedWebCliProbe = `const fs = require('node:fs'); const path = require('node:path'); process.stdout.write((${installedWebCli.toString()})('.'));`;
