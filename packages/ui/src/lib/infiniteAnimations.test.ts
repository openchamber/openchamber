import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An infinite CSS animation draws every frame for as long as it is on screen,
 * which is what kept an idle app busy (see the `theme-system` skill, "Animation
 * Contract"). A wait that can last shows `Spinner` (`components/ui/spinner.tsx`),
 * `BusyDots` or `useWaitingBlink`, all on one shared clock. The infinite CSS
 * animations left are bounded by the user: the short `animate-spin` of a button
 * or a quick load, the diff's expand spinner, the model name that scrolls while
 * hovered. A new one fails here until it is replaced or listed with a reason.
 */
const ALLOWED = [
  { file: 'index.css', declaration: 'animation: webkit-spin 1s linear infinite !important;' },
  { file: 'index.css', declaration: 'animation: oc-trailing-expand-spin 0.8s linear infinite;' },
  { file: 'index.css', declaration: 'animation: marquee-scroll 5s linear infinite alternate;' },
  { file: 'components/views/PierreDiffViewer.tsx', declaration: 'animation: oc-expand-spin 0.8s linear infinite;' },
];

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INFINITE_DECLARATION = /animation(?:-iteration-count)?\s*:[^;\n]*\binfinite\b[^;\n]*;?/g;
const PULSE_CLASS = /\banimate-(?:pulse|ping|bounce)\b|\banimate-\[[^\]]*\]/g;

const sourceFiles = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\.|__tests__\//.test(file));

test('no infinite CSS animation outside the short, user-bounded ones', () => {
  const found: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    for (const match of text.matchAll(INFINITE_DECLARATION)) {
      const declaration = match[0].trim();
      if (!ALLOWED.some((entry) => entry.file === file && entry.declaration === declaration)) {
        found.push(`${file}: ${declaration}`);
      }
    }
    if (!file.endsWith('.css')) {
      for (const match of text.matchAll(PULSE_CLASS)) found.push(`${file}: ${match[0]}`);
    }
  }
  expect(found).toEqual([]);
});

test('every allowed infinite animation still exists', () => {
  for (const entry of ALLOWED) {
    expect(readFileSync(join(SOURCE_ROOT, entry.file), 'utf8')).toContain(entry.declaration);
  }
});
