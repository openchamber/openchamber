import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rules measured on an iPhone that keep the Capacitor app's motion on the
 * compositor and its keyboard fast. Each one was broken once and cost a
 * visible stutter or delay; the measurements and how to repeat them are in
 * the `performance-engineering` skill, references/ios-webkit.md.
 */

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(SOURCE_ROOT, file), 'utf8');

const sourceFiles = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\.|__tests__\//.test(file));

// Properties Core Animation can run off the main thread.
const COMPOSITED = /^(transform|translate|scale|rotate|opacity|all)$/;

// Splits a comma list at the top level, leaving the commas inside `linear(…)`.
const splitTopLevel = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
};

// Custom properties whose value is a `linear()` easing, plus the keyboard's
// (written from KEYBOARD_EASING_CSS at runtime).
const linearEasingVariables = (): Set<string> => {
  const names = new Set(['--oc-kb-easing']);
  for (const file of sourceFiles.filter((name) => name.endsWith('.css'))) {
    for (const match of read(file).matchAll(/(--[\w-]+)\s*:\s*linear\(/g)) names.add(match[1]);
  }
  return names;
};

/**
 * A `linear()` easing on a composited property. WebKit hands no animation
 * with a `linear()` easing to Core Animation (KeyframeEffect::canBeAccelerated),
 * so it runs on the main thread at 60 Hz beside a 120 Hz keyboard and stalls
 * with every task. Keyboard motion takes `keyboardKeyframes` with
 * `easing: 'linear'` instead. Listed here: the ones that still do, each with
 * its reason.
 */
const ALLOWED_LINEAR_COMPOSITED = [
  // Popups open on the popup spring where Chromium composites it; iOS WebKit
  // gets a cubic-bezier of the same curve (the test below).
  { file: 'styles/design-system.css', selector: '.oc-popup-motion' },
];

test('popups ease on a cubic-bezier in iOS WebKit', () => {
  expect(/@supports \(-webkit-touch-callout: none\) \{\s*\.oc-popup-motion \{[^}]*transition-timing-function: cubic-bezier\(/.test(read('styles/design-system.css'))).toBe(true);
});

const cssRules = (text: string) => Array.from(
  text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  (match) => ({ selector: match[1].trim(), body: match[2] }),
);

const declaration = (body: string, property: string): string | null => {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : null;
};

// A shorthand segment names its property anywhere among durations, easings
// and keywords, or not at all, which means `all`.
const TRANSITION_KEYWORDS = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|normal|allow-discrete|none|initial|inherit|unset)$/;
const shorthandProperty = (segment: string): string => {
  const tokens = segment.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '()').split(/\s+/);
  return tokens.find((token) => /^-?[a-z][a-z-]*$/.test(token) && !TRANSITION_KEYWORDS.test(token)) ?? 'all';
};

test('shorthand segments name their property in any order', () => {
  expect(shorthandProperty('var(--oc-kb-duration) var(--oc-kb-easing)')).toBe('all');
  expect(shorthandProperty('200ms opacity linear(0, 1)')).toBe('opacity');
  expect(shorthandProperty('bottom var(--oc-kb-duration, 0.25s) var(--oc-kb-easing, ease-out)')).toBe('bottom');
  expect(shorthandProperty('transform 0.2s ease-out 50ms')).toBe('transform');
});

test('no linear() easing on a composited property in CSS', () => {
  const variables = linearEasingVariables();
  const isLinear = (easing: string) => /\blinear\(/.test(easing)
    || Array.from(variables).some((name) => easing.includes(`var(${name}`));
  const found: string[] = [];
  for (const file of sourceFiles.filter((name) => name.endsWith('.css'))) {
    for (const { selector, body } of cssRules(read(file))) {
      const offending: string[] = [];
      const shorthand = declaration(body, 'transition');
      if (shorthand) {
        for (const segment of splitTopLevel(shorthand)) {
          const property = shorthandProperty(segment);
          if (COMPOSITED.test(property) && isLinear(segment)) offending.push(property);
        }
      }
      const timing = declaration(body, 'transition-timing-function') ?? declaration(body, 'animation-timing-function');
      const properties = declaration(body, 'transition-property');
      if (timing && isLinear(timing)) {
        const named = properties ? splitTopLevel(properties) : ['all'];
        offending.push(...named.filter((property) => COMPOSITED.test(property)));
      }
      if (offending.length === 0) continue;
      if (ALLOWED_LINEAR_COMPOSITED.some((entry) => entry.file === file && entry.selector === selector)) continue;
      found.push(`${file}: ${selector} (${offending.join(', ')})`);
    }
  }
  expect(found).toEqual([]);
});

// Tailwind's arbitrary easings (`ease-[…]`) land on whatever the element
// transitions, often opacity or a transform; none takes a linear() easing.
test('no linear() easing in an arbitrary Tailwind easing', () => {
  const variables = Array.from(linearEasingVariables());
  const found: string[] = [];
  for (const file of sourceFiles.filter((name) => !name.endsWith('.css'))) {
    for (const match of read(file).matchAll(/\bease-\[[^\]]*\]/g)) {
      if (/linear\(/.test(match[0]) || variables.some((name) => match[0].includes(name))) found.push(`${file}: ${match[0]}`);
    }
  }
  expect(found).toEqual([]);
});

test('every allowed linear() rule still exists', () => {
  for (const entry of ALLOWED_LINEAR_COMPOSITED) {
    expect(cssRules(read(entry.file)).some((rule) => rule.selector === entry.selector)).toBe(true);
  }
});

/**
 * Script-driven motion on a spring's `linear()` easing is allowed only where
 * it animates a property the compositor cannot run anyway (a height, a
 * width, a `bottom`, a clip). A new use fails here until it is listed with
 * what it animates.
 */
const LINEAR_EASING_USERS = [
  // KB_ANIM_EASING → --oc-kb-easing, read by `bottom` and `height` transitions in mobile.css.
  'apps/mobileNativeChrome.ts',
  // morphTiming: the composer box height and the clip; transforms take keyboardKeyframes.
  'components/chat/composer/state/mobileComposerMorph.ts',
  // Width and height morphs of popups and panels.
  'lib/motion/useSizeMorph.ts',
];

test('spring easings reach script-driven motion only where it cannot be composited', () => {
  const users = sourceFiles
    .filter((file) => !file.endsWith('.css') && file !== 'lib/mobileKeyboardTiming.ts' && !file.startsWith('lib/motion/springs'))
    .filter((file) => /\bKEYBOARD_EASING_CSS\b|--oc-motion-[\w-]+-easing/.test(read(file)));
  expect(users.sort()).toEqual([...LINEAR_EASING_USERS].sort());
});

/**
 * The keyboard geometry inherited from the document root restyled the whole
 * page on every keyboard open and close (about 150 ms on a long chat). The
 * values are registered non-inherited and written only on the elements that
 * read them, through lib/mobileKeyboardInsets.ts.
 */
const KEYBOARD_VARIABLES = ['--oc-keyboard-inset', '--oc-kb-layout', '--oc-kb-surface', '--oc-kb-scroll-inset'];

test('keyboard geometry is registered non-inherited', () => {
  const css = read('styles/mobile.css');
  for (const name of KEYBOARD_VARIABLES) {
    expect(new RegExp(`@property ${name} \\{[^}]*inherits:\\s*false`).test(css)).toBe(true);
  }
});

test('keyboard geometry is written only through mobileKeyboardInsets', () => {
  const writers = sourceFiles
    .filter((file) => !file.endsWith('.css') && file !== 'lib/mobileKeyboardInsets.ts')
    .filter((file) => KEYBOARD_VARIABLES.some((name) => new RegExp(`setProperty\\(\\s*['"\`]${name}['"\`]`).test(read(file))));
  expect(writers).toEqual([]);
});

/**
 * Whatever reads the keyboard's height takes it into its layout once, where
 * the change is invisible, and what sits at its bottom rides the keyboard on
 * a transform (`data-keyboard-rider`). A layout property transitioning with
 * the keyboard re-lays the page out on every frame on the main thread and
 * climbs in 60 Hz steps beside it.
 */
test('no layout property transitions with the keyboard', () => {
  const LAYOUT = /^(top|bottom|left|right|inset|height|max-height|min-height|width|padding|padding-bottom|margin|margin-bottom|all)$/;
  const found: string[] = [];
  for (const file of sourceFiles.filter((name) => name.endsWith('.css'))) {
    for (const { selector, body } of cssRules(read(file))) {
      if (!/var\(--oc-(keyboard-inset|kb-layout|kb-surface|kb-scroll-inset)/.test(body)) continue;
      const shorthand = declaration(body, 'transition');
      const properties = [
        ...(shorthand ? splitTopLevel(shorthand).map(shorthandProperty) : []),
        ...splitTopLevel(declaration(body, 'transition-property') ?? ''),
      ];
      const moving = properties.filter((property) => LAYOUT.test(property));
      if (moving.length > 0) found.push(`${file}: ${selector} (${moving.join(', ')})`);
    }
  }
  expect(found).toEqual([]);
});

// Without it an iPhone caps the app's own animations at 60 Hz while the
// keyboard beside them runs at 120 Hz.
test('the iOS app opts in to 120 Hz animation', () => {
  const plist = readFileSync(join(SOURCE_ROOT, '../../mobile/ios/App/App/Info.plist'), 'utf8');
  expect(/<key>CADisableMinimumFrameDurationOnPhone<\/key>\s*<true\/>/.test(plist)).toBe(true);
});
