const fs = require('node:fs');
const path = require('node:path');

const iconsDir = path.join(__dirname, '..', 'resources', 'icons');
const sourceIconPath = path.join(iconsDir, 'icon.png');
const outputDir = path.join(iconsDir, 'linux');

// hicolor sizes indexed by gtk-update-icon-cache; sized icons let DE launchers
// resolve `Icon=openchamber` without a generic fallback.
const HICOLOR_SIZES = [16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512];

if (!fs.existsSync(sourceIconPath)) {
  throw new Error(`Missing Linux source icon at ${sourceIconPath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const sharp = require('sharp');

Promise.all(HICOLOR_SIZES.map((size) => {
  const outputPath = path.join(outputDir, `${size}x${size}.png`);
  return sharp(sourceIconPath)
    .resize(size, size, { fit: 'contain' })
    .png()
    .toFile(outputPath)
    .then(() => console.log(`Generated ${outputPath}`));
})).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});