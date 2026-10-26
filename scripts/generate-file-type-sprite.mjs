#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'packages/ui/src/assets/icons/file-types');
const SPRITE_FILE = path.join(ICONS_DIR, 'sprite.svg');
const IDS_FILE = path.join(ROOT, 'packages/ui/src/lib/fileTypeIconIds.ts');

const OPEN_TAG_PATTERN = /<svg\b([^>]*)>([\s\S]*?)<\/svg>\s*$/i;
const XML_DECL_PATTERN = /^\s*<\?xml[^>]*>\s*/i;
const VIEW_BOX_PATTERN = /\bviewBox\s*=\s*"([^"]+)"/i;
const ID_ATTR_PATTERN = /\bid=(['"])([^'"\s>]+)\1/g;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeInnerSvg = (iconId, value) => {
  let inner = value.replace(/\bxlink:href=/g, 'href=');
  const idMap = new Map();
  for (const match of inner.matchAll(ID_ATTR_PATTERN)) {
    const sourceId = match[2];
    if (!sourceId || idMap.has(sourceId)) {
      continue;
    }
    idMap.set(sourceId, `${iconId}__${sourceId}`);
  }

  const idsBySpecificity = Array.from(idMap.keys()).sort((left, right) => right.length - left.length);
  for (const sourceId of idsBySpecificity) {
    const targetId = idMap.get(sourceId);
    if (!targetId) {
      continue;
    }

    const escapedSourceId = escapeRegExp(sourceId);
    const idAttrPattern = new RegExp(`\\bid=(['"])${escapedSourceId}\\1`, 'g');
    const hrefPattern = new RegExp(`\\bhref=(['"])#${escapedSourceId}\\1`, 'g');
    const urlPattern = new RegExp(`url\\((['"]?)#${escapedSourceId}\\1\\)`, 'g');

    inner = inner.replace(idAttrPattern, (_full, quote) => `id=${quote}${targetId}${quote}`);
    inner = inner.replace(hrefPattern, (_full, quote) => `href=${quote}#${targetId}${quote}`);
    inner = inner.replace(urlPattern, (_full, quote) => quote ? `url(${quote}#${targetId}${quote})` : `url(#${targetId})`);
  }

  return inner;
};

const files = fs.readdirSync(ICONS_DIR)
  .filter((fileName) => fileName.endsWith('.svg') && fileName !== 'sprite.svg')
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error(`No source SVG files found in ${ICONS_DIR}`);
  process.exit(1);
}

const symbols = [];
const viewBoxById = new Map();

for (const fileName of files) {
  const filePath = path.join(ICONS_DIR, fileName);
  const raw = fs.readFileSync(filePath, 'utf8').replace(XML_DECL_PATTERN, '').trim();
  const match = raw.match(OPEN_TAG_PATTERN);

  if (!match) {
    console.error(`Could not parse SVG root from ${fileName}`);
    process.exit(1);
  }

  const attributes = match[1] || '';
  const iconId = fileName.replace(/\.svg$/i, '');
  const inner = normalizeInnerSvg(iconId, (match[2] || '').trim());
  const viewBoxMatch = attributes.match(VIEW_BOX_PATTERN);
  const viewBox = viewBoxMatch?.[1]?.trim() || '0 0 24 24';

  viewBoxById.set(iconId, viewBox);
  symbols.push({ id: iconId, viewBox, inner });
}

const baseIds = Array.from(viewBoxById.keys());
for (const iconId of baseIds) {
  if (iconId.endsWith('_light')) {
    continue;
  }

  const lightId = `${iconId}_light`;
  if (!viewBoxById.has(lightId)) {
    symbols.push({
      id: lightId,
      viewBox: viewBoxById.get(iconId) || '0 0 24 24',
      inner: `<use href="#${iconId}" />`,
    });
  }
}

symbols.sort((left, right) => left.id.localeCompare(right.id));

const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="0" height="0">',
  '  <defs>',
];

for (const symbol of symbols) {
  lines.push(`    <symbol id="${symbol.id}" viewBox="${symbol.viewBox}">`);
  for (const line of symbol.inner.split('\n')) {
    lines.push(`      ${line.replace(/\s+$/, '')}`);
  }
  lines.push('    </symbol>');
}

lines.push('  </defs>');
lines.push('</svg>');
lines.push('');

fs.writeFileSync(SPRITE_FILE, lines.join('\n'));

const idLines = [
  "export const FILE_TYPE_ICON_IDS = new Set<string>([",
  ...symbols.map((symbol) => `  '${symbol.id}',`),
  ']);',
  '',
];

fs.writeFileSync(IDS_FILE, idLines.join('\n'));
console.log(`Generated ${path.relative(ROOT, SPRITE_FILE)} with ${symbols.length} symbols (${files.length} source SVG files)`);
console.log(`Generated ${path.relative(ROOT, IDS_FILE)} with ${symbols.length} icon ids`);
