import assert from 'node:assert/strict';
import test from 'node:test';

import { NIGHTS_KEPT } from '../changelog/canary-notes.mjs';
import { manifestFiles, planMirror, releaseVersionOf, retrying } from './mirror-to-r2.mjs';

const stable = (name) => `desktop/stable/${name}`;
const canary = (name) => `desktop/canary/${name}`;

test('reads every file a manifest names', () => {
  const manifest = `version: 2.7.0
files:
  - url: OpenChamber-2.7.0-mac-arm64.zip
    sha512: abc
    size: 1
  - url: 'OpenChamber-2.7.0-mac-x64.zip'
    size: 2
path: OpenChamber-2.7.0-mac-arm64.zip
releaseDate: '2026-11-08T01:46:33.163Z'
`;
  assert.deepEqual(manifestFiles(manifest), ['OpenChamber-2.7.0-mac-arm64.zip', 'OpenChamber-2.7.0-mac-x64.zip', 'OpenChamber-2.7.0-mac-arm64.zip']);
});

test('tells a release and a Canary night from the file name', () => {
  assert.equal(releaseVersionOf('OpenChamber-2.7.0-win-x64.exe'), '2.7.0');
  assert.equal(releaseVersionOf('OpenChamber-2.7.1-canary.20261108.12-29901784-android.apk'), '2.7.1-canary.20261108.12');
  assert.equal(releaseVersionOf('OpenChamber-canary-android.apk'), null);
  assert.equal(releaseVersionOf('canary-notes.json'), null);
});

test('Stable keeps the previous release whole, deletes older files and keeps every blockmap', () => {
  const keys = ['2.6.0', '2.6.1', '2.7.0'].flatMap((version) => [stable(`OpenChamber-${version}-win-x64.exe`), stable(`OpenChamber-${version}-win-x64.exe.blockmap`)])
    .concat(stable('latest.yml'));
  assert.deepEqual(planMirror(keys, '2.7.0').remove, [stable('OpenChamber-2.6.0-win-x64.exe')]);
  // Mirroring the next release: 2.7.0 becomes the previous one and stays.
  assert.deepEqual(planMirror(keys, '2.7.1').remove, [stable('OpenChamber-2.6.0-win-x64.exe'), stable('OpenChamber-2.6.1-win-x64.exe')]);
});

test('the release the website links stays when a release in between was never published', () => {
  // 2.7.0 is live; 2.7.1 reached the mirror but was never published; now 2.7.2.
  const keys = ['2.7.0', '2.7.1'].map((version) => stable(`OpenChamber-${version}-win-x64.exe`));
  assert.deepEqual(planMirror(keys, '2.7.2', 'stable', ['2.7.0']).remove, []);
  assert.deepEqual(planMirror(keys, '2.7.2', 'stable').remove, [stable('OpenChamber-2.7.0-win-x64.exe')]);
});

test('Canary keeps the blockmaps of the nights its notes cover and nothing else of older nights', () => {
  const nights = Array.from({ length: NIGHTS_KEPT + 2 }, (_, index) => `2.7.1-canary.202611${String(index + 1).padStart(2, '0')}.${index + 1}`);
  const tonight = nights.at(-1);
  const keys = nights.flatMap((version) => [canary(`OpenChamber-${version}-win-x64.exe`), canary(`OpenChamber-${version}-win-x64.exe.blockmap`)])
    .concat(canary('latest.yml'), canary('OpenChamber-canary-android.apk'), canary('canary-notes.json'), canary('files.json'));
  const removed = planMirror(keys, tonight, 'canary').remove;
  // Every older night's installer goes; tonight's stays.
  for (const version of nights.slice(0, -1)) assert.ok(removed.includes(canary(`OpenChamber-${version}-win-x64.exe`)));
  assert.ok(!removed.includes(canary(`OpenChamber-${tonight}-win-x64.exe`)));
  // Blockmaps of the two nights beyond the kept ones go, the rest stay.
  assert.deepEqual(removed.filter((key) => key.endsWith('.blockmap')), nights.slice(0, 2).map((version) => canary(`OpenChamber-${version}-win-x64.exe.blockmap`)));
  // Files with fixed names are replaced, never deleted.
  assert.ok(!removed.some((key) => /canary-android\.apk$|canary-notes\.json$|files\.json$|\.yml$/.test(key)));
});

test('an empty mirror takes the first build', () => {
  assert.deepEqual(planMirror([], '2.7.0').remove, []);
  assert.deepEqual(planMirror([], '2.7.1-canary.20261108.12', 'canary').remove, []);
});

test('refuses a build older than one the mirror serves, and allows the same one again', () => {
  assert.match(planMirror([stable('OpenChamber-2.7.1-mac-arm64.zip')], '2.7.0').refuse, /2\.7\.1/);
  assert.deepEqual(planMirror([stable('OpenChamber-2.7.0-mac-arm64.zip')], '2.7.0').remove, []);
  assert.match(planMirror([stable('OpenChamber-2.10.0-win-x64.exe')], '2.9.0').refuse, /2\.10\.0/);
  // Nights order by day, then by run number.
  assert.match(planMirror([canary('OpenChamber-2.7.1-canary.20261109.3-win-x64.exe')], '2.7.1-canary.20261108.12', 'canary').refuse, /20261109/);
  assert.deepEqual(planMirror([canary('OpenChamber-2.7.1-canary.20261108.9-win-x64.exe')], '2.7.1-canary.20261108.12', 'canary').remove, [canary('OpenChamber-2.7.1-canary.20261108.9-win-x64.exe')]);
});

test('an upload that fails is tried again, and the last failure comes through', () => {
  let calls = 0;
  const flaky = () => { calls += 1; if (calls < 3) throw new Error('InvalidPart'); return 'done'; };
  assert.equal(retrying(flaky, { pauseMs: 0 }), 'done');
  assert.equal(calls, 3);

  calls = 0;
  const broken = () => { calls += 1; throw new Error(`InvalidPart ${calls}`); };
  assert.throws(() => retrying(broken, { pauseMs: 0 }), /InvalidPart 3/);
  assert.equal(calls, 3);
});
