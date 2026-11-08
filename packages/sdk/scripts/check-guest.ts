#!/usr/bin/env bun
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { GUEST_PROVIDER_LOGO_BYTES_MAX } from '../dist/index.js';
import { parseManifestJson } from '../dist/schemas.js';

const root = resolve(process.argv[2] ?? '.');
const problems: string[] = [];

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** Every `.html` file the manifest names, wherever in `contributes` it sits. */
const pagesIn = (manifestText: string): string[] => (
  [...new Set([...manifestText.matchAll(/"([^"]+\.html)"/g)].flatMap(([, page]) => (page ? [page] : [])))]
);

const checkPage = async (page: string): Promise<void> => {
  const path = join(root, page);
  if (!await exists(path)) {
    problems.push(`${page} is missing.`);
    return;
  }
  const html = await readFile(path, 'utf8');
  for (const [, source] of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
    if (!source || /^[a-z]+:/i.test(source)) continue;
    const script = join(dirname(path), source);
    if (source.endsWith('.ts')) problems.push(`${page} loads ${source}. Load the bundled .js file.`);
    else if (!await exists(script)) problems.push(`${page} loads ${source}, which is not built yet. Run the bundler.`);
  }
};

const checkService = async (entry: string): Promise<void> => {
  const path = join(root, entry);
  if (!await exists(path)) {
    problems.push(`${entry} is missing. Bundle it with --node.`);
    return;
  }
  const code = await readFile(path, 'utf8');
  if (/from\s+["']@openchamber\/sdk/.test(code)) problems.push(`${entry} still imports @openchamber/sdk. Bundle it with --node.`);
  if (!code.includes('OPENCHAMBER_SERVICE_PORT')) problems.push(`${entry} never reads OPENCHAMBER_SERVICE_PORT, so the host cannot reach it.`);
};

const checkProviderLogo = async (logo: string): Promise<void> => {
  const path = join(root, logo);
  if (!await exists(path)) {
    problems.push(`${logo} is missing.`);
    return;
  }
  const { size } = await stat(path);
  if (size === 0 || size > GUEST_PROVIDER_LOGO_BYTES_MAX) problems.push(`${logo} must be 1 byte to 1 MB.`);
};

const manifestPath = join(root, 'package.json');
if (!await exists(manifestPath)) {
  console.error(`No package.json in ${root}.`);
  process.exit(1);
}
const parsed = parseManifestJson(await readFile(manifestPath, 'utf8'));
if (!parsed.ok) {
  console.error(`package.json: ${parsed.code}: ${parsed.message}`);
  process.exit(1);
}
const { contributes } = parsed.manifest;
await Promise.all(pagesIn(JSON.stringify(contributes)).map(checkPage));
if (contributes.service) await checkService(contributes.service.entry);
await Promise.all(Object.values(contributes.providerLogos ?? {}).map(checkProviderLogo));
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log('Package is ready to add in Settings → Extensions.');
