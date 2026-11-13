import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const generator = fileURLToPath(new URL('./generate-icon-sprite.mjs', import.meta.url));
const geometryModule = fileURLToPath(new URL('./brand/geometry.mjs', import.meta.url));
const appGlyphsModule = fileURLToPath(new URL('./icons/open-in-apps.mjs', import.meta.url));
const remixDirectory = path.dirname(fileURLToPath(import.meta.resolve('@remixicon/react')));

for (const declaration of [
  'const icons: Record<Kind, IconName> = { ready: "chat-check" };',
  'const icons = { ready: "chat-check" } satisfies Record<Kind, IconName>;',
  'const icons = { ready: "chat-check" } as const satisfies Record<Kind, IconName>;',
]) {
  test(`generates symbols from the icon record ${declaration}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oc-icon-generator-'));
    try {
      // Given an isolated source tree using the real installed icon bundle.
      const scripts = path.join(root, 'scripts');
      const source = path.join(root, 'packages/ui/src/components/icon');
      const modules = path.join(root, 'node_modules/@remixicon');
      const brandDir = path.join(scripts, 'brand');
      const iconsDir = path.join(scripts, 'icons');
      await Promise.all([mkdir(scripts, { recursive: true }), mkdir(source, { recursive: true }), mkdir(modules, { recursive: true }), mkdir(brandDir, { recursive: true }), mkdir(iconsDir, { recursive: true })]);
      await copyFile(generator, path.join(scripts, 'generate-icon-sprite.mjs'));
      await copyFile(geometryModule, path.join(brandDir, 'geometry.mjs'));
      await copyFile(appGlyphsModule, path.join(iconsDir, 'open-in-apps.mjs'));
      await symlink(remixDirectory, path.join(modules, 'react'), 'junction');
      await writeFile(path.join(source, 'fixture.ts'), declaration);

      // When the generator scans that tree.
      execFileSync(process.execPath, [path.join(scripts, 'generate-icon-sprite.mjs')], { timeout: 30_000 });

      // Then the dynamically selected icon has renderable SVG data.
      const sprite = await readFile(path.join(source, 'sprite.ts'), 'utf8');
      assert.match(sprite, /"chat-check": `<path d="[^"]+" fill="currentColor"\/>`/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
