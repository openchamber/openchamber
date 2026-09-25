import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { builtInExtensionSchema, builtInRegistrySchema, DEFAULT_BUILTIN_ROOT } from '../packages/web/server/lib/guests/builtins.js';
import { inspectGuestPackage } from '../packages/web/server/lib/guests/catalog.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const relativeFile = z.string().min(1).refine((value) => !value.includes('\\') && !value.includes('\0')
  && !path.isAbsolute(value) && value.split('/').every((part) => part && part !== '.' && part !== '..'));
const sourceSchema = z.object({
  version: z.literal(1),
  extensions: z.array(builtInExtensionSchema.extend({
    files: z.array(relativeFile),
    build: z.array(z.object({ entry: relativeFile, out: relativeFile, target: z.enum(['browser', 'node']) })),
  })),
}).superRefine(({ extensions }, context) => {
  for (const entry of extensions) {
    const outputs = new Set(['package.json']);
    for (const file of [...entry.files, ...entry.build.map((target) => target.out)]) {
      if (outputs.has(file)) context.addIssue({ code: 'custom', message: `Duplicate built-in output: ${entry.id}/${file}` });
      outputs.add(file);
    }
  }
});

const inside = async (root, relative) => {
  const resolved = await fs.realpath(path.join(root, relative));
  if (!resolved.startsWith(root + path.sep)) throw new Error('Built-in source file escapes its package');
  return resolved;
};

export const buildBuiltInExtensions = async ({ sourceRoot = path.join(repoRoot, 'packages/extensions'), outDir = DEFAULT_BUILTIN_ROOT } = {}) => {
  outDir = path.resolve(outDir);
  sourceRoot = await fs.realpath(sourceRoot);
  const source = sourceSchema.parse(JSON.parse(await fs.readFile(path.join(sourceRoot, 'registry.json'), 'utf8')));
  const registry = builtInRegistrySchema.parse(source);
  const app = z.object({ version: z.string().min(1) }).parse(JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')));
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(outDir), '.builtin-build-'));
  const previous = `${outDir}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    for (const entry of source.extensions) {
      const root = await inside(sourceRoot, entry.directory);
      const destination = path.join(staging, entry.directory);
      await fs.mkdir(destination, { recursive: true });
      const manifest = z.object({ name: z.string(), openchamber: z.object({}).passthrough() }).passthrough()
        .parse(JSON.parse(await fs.readFile(await inside(root, 'package.json'), 'utf8')));
      await fs.writeFile(path.join(destination, 'package.json'), `${JSON.stringify({ ...manifest, version: app.version }, null, 2)}\n`);
      for (const file of entry.files) {
        const from = await inside(root, file);
        const to = path.join(destination, file);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      }
      for (const target of entry.build) {
        const result = await Bun.build({
          entrypoints: [await inside(root, target.entry)],
          target: target.target,
          format: target.target === 'browser' ? 'iife' : 'esm',
          minify: target.target === 'browser',
          sourcemap: 'none',
          env: 'disable',
          plugins: [{
            name: 'public-sdk-entrypoints',
            setup(build) {
              build.onResolve({ filter: /^@openchamber\/sdk(?:\/ui|\/schemas)?$/ }, ({ path: specifier }) => ({
                path: path.join(repoRoot, 'packages/sdk/src', specifier.endsWith('/ui') ? 'ui/index.ts' : specifier.endsWith('/schemas') ? 'schemas.ts' : 'index.ts'),
              }));
            },
          }],
          loader: { '.svg': 'dataurl', '.png': 'dataurl' },
          write: false,
        });
        if (!result.success || result.outputs.length !== 1) throw new Error(`Built-in ${entry.id} must produce one self-contained ${target.target} entry`);
        const output = path.join(destination, target.out);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, new Uint8Array(await result.outputs[0].arrayBuffer()));
      }
      const inspected = await inspectGuestPackage(destination, { openchamberVersion: app.version });
      if (!inspected.ok || inspected.guest.id !== entry.id) throw new Error(`Built-in package failed validation: ${entry.id}`);
    }
    await fs.writeFile(path.join(staging, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
    // mkdtemp creates an owner-only directory; runtime may use a different UID.
    await fs.chmod(staging, 0o755);
    try { await fs.rename(outDir, previous); movedPrevious = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(staging, outDir); }
    catch (error) {
      if (movedPrevious) await fs.rename(previous, outDir);
      throw error;
    }
    if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
    return registry;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const registry = await buildBuiltInExtensions();
  console.log(`Built ${registry.extensions.length} built-in extension(s).`);
}
