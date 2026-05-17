// Generate a social changelog card for OpenChamber.
//
//   bun run scripts/changelog-card/generate.mjs "v0.42.0" \
//     "Sessions now *stream responses* token-by-token across every device."
//
//   node scripts/changelog-card/generate.mjs "<title>" "<sentence>" [options]
//
// Args:
//   1  title     — short heading, typically a version number (e.g. v0.42.0)
//   2  sentence   — the feature blurb. Word-wraps to fit the card width.
//                   Wrap a phrase in *asterisks* to highlight it in the
//                   site's serif-italic accent (matches openchamber.dev).
//
// Options:
//   --out <path>   output PNG (default: ./changelog-<title>.png in cwd)
//   --bg <path>    background plate (default: docs/references/text_plate.png)
//
// The sentence wraps automatically; the version + sentence block is
// bottom-anchored over a readability scrim so the glowing plate stays visible.
//
// Fonts (IBM Plex Sans, Instrument Serif) are fetched once from Fontsource
// into ./.fonts (gitignored) and wired into fontconfig for Pango.

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, '..', '..');
const fontsDir = path.join(toolDir, '.fonts');

const FONTS = [
  {
    file: 'IBMPlexSans-SemiBold.ttf',
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@latest/latin-600-normal.ttf',
  },
  {
    file: 'InstrumentSerif-Italic.ttf',
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/instrument-serif@latest/latin-400-italic.ttf',
  },
];

// ---- palette (mirrors openchamber.dev) -------------------------------------
const CREAM = '#F4ECE0'; // primary text
const AMBER = '#E8C98A'; // accent / highlight / version label
const SCRIM = '#07070A'; // scrim ink

// ---- args ------------------------------------------------------------------
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opt.out = argv[++i];
    else if (a === '--bg') opt.bg = argv[++i];
    else pos.push(a);
  }
  return { title: pos[0], sentence: pos[1], opt };
}

const exists = (p) => access(p).then(() => true, () => false);

async function ensureFonts() {
  await mkdir(fontsDir, { recursive: true });
  for (const { file, url } of FONTS) {
    const dest = path.join(fontsDir, file);
    if (await exists(dest)) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`fetched ${file}`);
  }
  const confFile = path.join(fontsDir, 'fonts.conf');
  await writeFile(
    confFile,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${path.join(fontsDir, '.fc-cache')}</cachedir>
</fontconfig>
`
  );
  process.env.FONTCONFIG_FILE = confFile;
}

function escapeMarkup(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Turn *phrase* into a serif-italic amber span; everything else stays cream.
function toPangoMarkup(sentence) {
  const escaped = escapeMarkup(sentence);
  const withHighlights = escaped.replace(
    /\*([^*]+)\*/g,
    (_, phrase) =>
      `<span foreground="${AMBER}" font_family="Instrument Serif" font_style="italic">${phrase}</span>`
  );
  return `<span foreground="${CREAM}">${withHighlights}</span>`;
}

function scrimSvg(w, h) {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="${SCRIM}" stop-opacity="0.04"/>
      <stop offset="18%" stop-color="${SCRIM}" stop-opacity="0.04"/>
      <stop offset="38%" stop-color="${SCRIM}" stop-opacity="0.32"/>
      <stop offset="62%" stop-color="${SCRIM}" stop-opacity="0.56"/>
      <stop offset="100%" stop-color="${SCRIM}" stop-opacity="0.72"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
</svg>`;
}

async function main() {
  const { title, sentence, opt } = parseArgs(process.argv.slice(2));
  if (!title || !sentence) {
    console.error(
      'Usage: generate.mjs "<title>" "<sentence>" [--out file.png] [--bg plate.png]\n' +
        'Wrap a phrase in *asterisks* to highlight it.'
    );
    process.exit(1);
  }

  await ensureFonts();
  const { default: sharp } = await import('sharp');

  const bgPath = opt.bg
    ? path.resolve(process.cwd(), opt.bg)
    : path.join(repoRoot, 'docs', 'references', 'text_plate.png');
  if (!(await exists(bgPath))) throw new Error(`Background not found: ${bgPath}`);

  const bg = sharp(await readFile(bgPath));
  const { width: W, height: H } = await bg.metadata();

  const marginX = Math.round(W * 0.077); // ~130px on the 1691px plate
  const wrapWidth = W - marginX * 2;

  // Sentence — Pango wraps it to wrapWidth; highlights via markup.
  const sentenceBuf = await sharp({
    text: {
      text: toPangoMarkup(sentence),
      font: 'IBM Plex Sans 92',
      rgba: true,
      width: wrapWidth,
      wrap: 'word',
      align: 'left',
      spacing: 18,
    },
  })
    .png()
    .toBuffer();
  const sMeta = await sharp(sentenceBuf).metadata();

  // Title — version label, amber, slightly tracked.
  const titleBuf = await sharp({
    text: {
      text: `<span foreground="${AMBER}" letter_spacing="2048">${escapeMarkup(
        title
      )}</span>`,
      font: 'IBM Plex Sans 64',
      rgba: true,
      align: 'left',
    },
  })
    .png()
    .toBuffer();
  const tMeta = await sharp(titleBuf).metadata();

  // Center the title + sentence block vertically on the plate.
  const titleGap = Math.round(H * 0.028); // gap between eyebrow and sentence
  const blockHeight = tMeta.height + titleGap + sMeta.height;
  const blockTop = Math.round((H - blockHeight) / 2);
  const titleTop = blockTop;
  const sentenceTop = blockTop + tMeta.height + titleGap;

  const outPath = opt.out
    ? path.resolve(process.cwd(), opt.out)
    : path.resolve(
        process.cwd(),
        `changelog-${String(title).replace(/[^\w.-]+/g, '-')}.png`
      );

  await bg
    .composite([
      { input: Buffer.from(scrimSvg(W, H)), top: 0, left: 0 },
      { input: titleBuf, top: titleTop, left: marginX },
      { input: sentenceBuf, top: sentenceTop, left: marginX },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`wrote ${outPath} (${W}x${H})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
