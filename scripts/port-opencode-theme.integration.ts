import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { compactTheme, requireTheme } from '../packages/ui/src/lib/theme/definition';
import { colorHue, contrastRatio, mixColor } from '../packages/ui/src/lib/theme/color';

// Integration suite for the OpenCode theme porter (./port-opencode-theme.ts),
// collected by the root test run (scripts/run-isolated-tests.mjs).
//
// Precondition — a sibling OpenCode checkout. The porter converts themes from
// a source checkout of OpenCode that must sit beside this repository:
//
//     <parent>/openchamber    this repository
//     <parent>/opencode      the OpenCode checkout (read-only)
//
// Set OPENCHAMBER_OPENCODE_DIR to the checkout's path when it lives somewhere
// else; the porter and this suite both honour it.
//
// When the checkout is absent the suite must not fail with a module-not-found
// error before any test runs: the porter and the sibling resolvers are
// imported dynamically only when the checkout is present, and every test is
// registered as an explicit skip naming the missing paths, so the root test
// run stays green and the skip is visible in its output.
const siblingCheckout = process.env.OPENCHAMBER_OPENCODE_DIR
  ? resolve(process.env.OPENCHAMBER_OPENCODE_DIR)
  : resolve(import.meta.dirname, '../../opencode');
const sourceDirectory = join(siblingCheckout, 'packages/ui/src/theme/themes');
const siblingPaths = [
  join(siblingCheckout, 'packages/ui/src/theme/resolve.ts'),
  join(siblingCheckout, 'packages/ui/src/theme/v2/resolve.ts'),
  sourceDirectory,
];
const missingSiblingPaths = siblingPaths.filter((siblingPath) => !existsSync(siblingPath));
const skipReason = missingSiblingPaths.length
  ? `requires the sibling OpenCode checkout (missing ${missingSiblingPaths.join(', ')}); see the header of scripts/port-opencode-theme.integration.ts`
  : undefined;
if (skipReason) console.warn(`port-opencode-theme.integration: all tests skipped — ${skipReason}`);

const porter = skipReason ? undefined : await import('./port-opencode-theme');
const { convertTheme, saveTheme, sourceSchema, tokenColor } = porter ?? {};
const siblingResolve = skipReason ? undefined : await import(join(siblingCheckout, 'packages/ui/src/theme/resolve.ts'));
const siblingResolveV2 = skipReason ? undefined : await import(join(siblingCheckout, 'packages/ui/src/theme/v2/resolve.ts'));
const resolveThemeVariant = siblingResolve?.resolveThemeVariant;
const resolveThemeVariantV2 = siblingResolveV2?.resolveThemeVariantV2;

const integrationTest = (name: string, fn: () => Promise<void> | void) =>
  skipReason ? test(name, { skip: skipReason }, fn) : test(name, fn);

const cli = join(import.meta.dirname, 'port-opencode-theme.ts');
const load = async (id: string) => sourceSchema.parse(JSON.parse(await readFile(join(sourceDirectory, `${id}.json`), 'utf8')));

integrationTest('all App variants retain syntax and diff colors, readable roles and round-trip', async () => {
  const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  const ids = new Set<string>();
  for (const file of files) {
    const source = await load(file.replace(/\.json$/, ''));
    for (const mode of ['light', 'dark'] as const) {
      const theme = requireTheme(convertTheme(source, mode));
      const tokens = new Map(Object.entries({
        ...resolveThemeVariant(source[mode], mode === 'dark'),
        ...resolveThemeVariantV2(source[mode], mode === 'dark'),
      }));
      assert.equal(theme.colors.syntax.base.keyword, tokenColor(tokens, 'syntax-keyword'), `${source.id}/${mode} keyword`);
      assert.equal(theme.colors.syntax.base.function, tokenColor(tokens, 'syntax-primitive'));
      assert.equal(theme.colors.syntax.base.number, tokenColor(tokens, 'syntax-constant'));
      assert.equal(theme.colors.syntax.tokens?.variableProperty, tokenColor(tokens, 'syntax-property'));
      assert.equal(theme.colors.syntax.tokens?.tag, tokenColor(tokens, 'syntax-string'));
      assert.equal(theme.colors.syntax.highlights?.diffAdded, tokenColor(tokens, 'syntax-diff-add'));
      assert.equal(theme.colors.syntax.highlights?.diffRemovedBackground, tokenColor(tokens, 'surface-diff-delete-base'));
      assert.deepEqual(requireTheme(JSON.parse(JSON.stringify(compactTheme(theme)))).colors, theme.colors);
      assert.ok((contrastRatio(theme.colors.surface.foreground, theme.colors.surface.background) ?? 0) >= 4.5, `${source.id}/${mode} body`);
      const bubble = theme.colors.chat?.userMessageBackground;
      assert.ok(bubble);
      assert.ok((contrastRatio(bubble, theme.colors.surface.background) ?? 0) >= 1.1, `${source.id}/${mode} bubble`);
      assert.ok((contrastRatio(theme.colors.surface.foreground, bubble, theme.colors.surface.background) ?? 0) >= 4.5, `${source.id}/${mode} message text`);
      assert.ok((contrastRatio(theme.colors.primary.base, theme.colors.surface.muted) ?? 0) >= 4.5, `${source.id}/${mode} primary`);
      assert.ok((contrastRatio(theme.colors.status.info, theme.colors.surface.muted) ?? 0) >= 4.5, `${source.id}/${mode} info`);
      for (const [color, low, high] of [
        [theme.colors.status.info, 185, 275], [theme.colors.status.success, 105, 170],
        [theme.colors.status.error, 0, 35], [theme.colors.status.warning, 35, 100],
        [theme.colors.pr?.merged ?? '', 285, 325], [theme.colors.pr?.blocked ?? '', 40, 65],
      ] as const) {
        const hue = colorHue(color, theme.colors.surface.background);
        assert.ok(hue !== null && hue >= low && hue <= high, `${source.id}/${mode} semantic hue ${color}`);
      }
      for (const background of [theme.colors.surface.background, theme.colors.surface.muted, theme.colors.surface.elevated]) {
        assert.ok((contrastRatio(theme.colors.interactive.border, background, theme.colors.surface.background) ?? Infinity) <= (mode === 'dark' ? 1.245 : 1.268), `${source.id}/${mode} quiet border`);
      }
      assert.equal(theme.colors.markdown?.bold, mixColor(mode === 'dark' ? '#ffffff' : '#000000', theme.colors.surface.foreground, 0.12, theme.colors.surface.background));
      assert.equal(theme.colors.markdown?.italic, theme.colors.surface.foreground);
      assert.ok(!JSON.stringify(theme).includes('var(--'));
      assert.ok(!ids.has(theme.metadata.id));
      ids.add(theme.metadata.id);
    }
  }
  assert.equal(ids.size, files.length * 2);
});

integrationTest('dark variants keep the authored accent and status seeds', async () => {
  const { colors } = convertTheme(await load('dracula'), 'dark');
  assert.equal(colors.primary.base, '#bd93f9');
  assert.equal(colors.status?.error, '#ff5555');
  assert.equal(colors.status?.success, '#50fa7b');
  assert.equal(colors.status?.info, '#8be9fd');
});

integrationTest('authored v2 accents win over the seeds', async () => {
  // OpenCode's own theme keeps a legacy peach seed but authors a blue accent.
  const source = await load('oc-2');
  for (const mode of ['light', 'dark'] as const) {
    const { colors } = requireTheme(convertTheme(source, mode));
    const hue = colorHue(colors.primary.base, colors.surface.background)!;
    assert.ok(hue > 250 && hue < 285, `${mode} primary ${colors.primary.base}`);
  }
});

integrationTest('v2 overrides drive the canvas and v1 syntax overrides stay exact', async () => {
  const source = await load('tokyonight');
  source.dark.v2Overrides = { ...source.dark.v2Overrides, 'v2-background-bg-base': '#101020' };
  source.dark.overrides = { ...source.dark.overrides, 'syntax-string': '#12ab34', 'markdown-strong': '#ff00ff' };
  const theme = requireTheme(convertTheme(source, 'dark'));
  assert.equal(theme.colors.surface.background, '#101020');
  assert.equal(theme.colors.syntax.base.string, '#12ab34');
  assert.notEqual(theme.colors.markdown?.bold, '#ff00ff');
});

integrationTest('color references retain alpha and reject missing, cyclic and unsupported values', () => {
  assert.equal(tokenColor(new Map([['a', 'var(--b)'], ['b', 'rgba(255, 0, 12, 0.5)']]), 'a'), '#ff000c80');
  assert.throws(() => tokenColor(new Map([['a', 'var(--a)']]), 'a'), /Circular/);
  assert.throws(() => tokenColor(new Map(), 'a'), /Missing/);
  assert.throws(() => tokenColor(new Map([['a', 'rgba(999, 0, 0, 1)']]), 'a'), /Unsupported/);
  assert.throws(() => tokenColor(new Map([['a', 'color-mix(in srgb, red, blue)']]), 'a'), /Unsupported/);
});

integrationTest('publication is idempotent, refuses edits and symlinks, and leaves no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'app-theme-test-'));
  try {
    const theme = convertTheme(await load('tokyonight'), 'dark');
    const outcomes = await Promise.all([saveTheme(directory, theme), saveTheme(directory, theme)]);
    assert.deepEqual(outcomes.sort(), ['created', 'unchanged']);
    const target = join(directory, `${theme.metadata.id}.json`);
    await writeFile(target, 'personal edit');
    await assert.rejects(saveTheme(directory, theme), /Refusing to replace/);
    assert.equal(await readFile(target, 'utf8'), 'personal edit');
    await rm(target);
    const other = join(directory, 'other.txt');
    await writeFile(other, 'keep');
    await symlink(other, target);
    await assert.rejects(saveTheme(directory, theme), /Refusing to replace/);
    assert.equal(await readFile(other, 'utf8'), 'keep');
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

integrationTest('CLI works outside the repo, dry-run writes nothing, and errors are nonzero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'app-theme-cli-test-'));
  const run = (...args: string[]) => spawnSync('bun', [cli, ...args], { cwd: directory, encoding: 'utf8' });
  try {
    const dry = run('--theme', 'oc-2', '--mode', 'dark', '--dry-run', '--output', join(directory, 'output'));
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Validated 1 variants/);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(run('--theme', 'missing-theme', '--dry-run').status, 1);
    assert.equal(run('--mode', 'invalid').status, 1);
    assert.equal(run('--unknown').status, 1);
    assert.equal(run('--help').status, 0);
    assert.match(run('--list').stdout, /tokyonight\tTokyonight/);
    const output = join(directory, 'output');
    const saved = run('--theme', 'tokyonight', '--output', output);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Created 2/);
    assert.match(run('--theme', 'tokyonight', '--output', output).stdout, /unchanged 2/);
    const edited = join(output, 'opencode-app-tokyonight-dark.json');
    await writeFile(edited, 'personal edit');
    const partial = run('--theme', 'tokyonight', '--theme', 'dracula', '--output', output);
    assert.equal(partial.status, 1);
    assert.match(partial.stdout, /Created 2; unchanged 1; errors 1/);
    assert.equal(await readFile(edited, 'utf8'), 'personal edit');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
