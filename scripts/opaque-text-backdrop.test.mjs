import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import config from '../postcss.config.js';

const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss');

test('the CSS pipeline gives alpha text an optional opaque backdrop without changing fills', async () => {
  const source = `
@import "tailwindcss";
@source inline("text-foreground/50 bg-background/50 opacity-50");
@theme { --color-foreground: #ffffff; --color-background: #101010; }
`;
  const { root } = await postcss(config.plugins).process(source, { from: new URL('../packages/ui/src/index.css', import.meta.url).pathname });
  const colors = [];
  const backgrounds = [];
  const opacities = [];
  root.walkDecls('color', ({ value }) => colors.push(value));
  root.walkDecls('background-color', ({ value }) => backgrounds.push(value));
  root.walkDecls('opacity', ({ value }) => opacities.push(value));
  assert.ok(colors.some(value => value.includes('var(--oc-text-backdrop, transparent)')));
  assert.ok(backgrounds.some(value => value.includes(', transparent)')));
  assert.ok(opacities.includes('50%'));
});
