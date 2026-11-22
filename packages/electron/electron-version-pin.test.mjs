import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Nix desktop build supplies its own Electron (flake.nix), separately from
// the version package.json declares. They drifted once (nixpkgs electron_43
// against "^44.9.0"), and main.mjs's Electron 44 calls then threw before the
// main window opened: the desktop app showed nothing.
describe('Electron version', () => {
  it('the Nix desktop build uses the Electron major package.json declares', () => {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    const declared = manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
    const declaredMajor = /(\d+)\./.exec(declared ?? '')?.[1];
    const flake = readFileSync(new URL('../../flake.nix', import.meta.url), 'utf8');
    const pinned = [...flake.matchAll(/electron = pkgs\.electron_(\d+);/g)].map((match) => match[1]);

    assert.ok(declaredMajor, 'package.json declares no electron version');
    assert.ok(pinned.length > 0, 'flake.nix pins no pkgs.electron_NN');
    assert.deepEqual(pinned, pinned.map(() => declaredMajor));
  });
});
