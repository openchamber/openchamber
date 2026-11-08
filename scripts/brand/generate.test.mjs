import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { textOutputs } from './generate.mjs';
import { PIXEL_CUBES, encodeIco, pixelCube } from './raster.mjs';

test('every generated text file matches scripts/brand', () => {
  const stale = [...textOutputs()]
    .filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8') !== text)
    .map(([path]) => relative(process.cwd(), path));
  expect(stale).toEqual([]);
});

test('the pixel cube has no anti-aliasing: every pixel is opaque or empty', () => {
  for (const size of Object.keys(PIXEL_CUBES).map(Number)) {
    const pixels = pixelCube(size);
    const alphas = new Set();
    for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i]);
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
  }
});

test('the pixel cube is outlined: no cube pixel touches an empty one', () => {
  const size = 16;
  const pixels = pixelCube(size);
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? null : pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = at(x, y);
      const isOutline = pixel[3] === 255 && pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0;
      if (pixel[3] === 0 || isOutline) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = at(x + dx, y + dy);
        expect(next !== null && next[3] === 255).toBe(true);
      }
    }
  }
});

test('an .ico directory points at each PNG with its size', () => {
  const pngs = [{ size: 16, png: Buffer.from('a') }, { size: 256, png: Buffer.from('bcd') }];
  const ico = encodeIco(pngs);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(2);
  expect(ico.readUInt8(6)).toBe(16);
  // 256 px is written as 0.
  expect(ico.readUInt8(6 + 16)).toBe(0);
  const offset = ico.readUInt32LE(6 + 16 + 12);
  expect(ico.subarray(offset, offset + 3).toString()).toBe('bcd');
});
