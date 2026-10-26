const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { convertVsCodeTheme, registerTheme } = require('./convert-vscode-theme.cjs');
const { importVSCodeTheme } = require('../packages/ui/src/lib/theme/vscode/import.ts');

test('CLI conversion shares the browser palette and stores compact registry entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-cli-'));
  try {
    const source = '{ // JSONC\n "name": "Sample Dark", "colors": { "editor.background": "#101820", "editor.foreground": "#eeeeee", }, "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#aa88ff" } }] }';
    const filename = path.join(directory, 'sample.jsonc');
    fs.writeFileSync(filename, source);
    const theme = convertVsCodeTheme(filename);
    assert.deepEqual(theme.colors, importVSCodeTheme(source, 'sample.jsonc').colors);
    assert.equal(theme.metadata.id, 'sample-dark');
    const registry = "import { requireTheme } from '../definition';\nexport const presetThemes = [\n].map(requireTheme);\n";
    const registered = registerTheme(registry, theme.metadata.id);
    assert.ok(registered.includes("from './sample-dark.json'"));
    assert.ok(!registered.includes('as Theme'));
    assert.equal(registerTheme(registered, theme.metadata.id), registered);
    const incomplete = "import existing from './sample-dark.json';\nexport const presetThemes = [\n].map(requireTheme);\n";
    assert.ok(registerTheme(incomplete, theme.metadata.id).includes('  existing,'));

    fs.writeFileSync(filename, JSON.stringify({ author: 'Fixture author', themes: [{ name: 'Zed Example', appearance: 'dark', style: { background: '#101010', text: '#eeeeee', syntax: { keyword: { color: '#aa88ff' } } } }] }));
    const zed = convertVsCodeTheme(filename);
    assert.equal(zed.colors.syntax.base.keyword, '#aa88ff');
    assert.equal(zed.metadata.author, 'Fixture author');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid non-interactive CLI invocations exit with deterministic human or JSON errors', () => {
  const script = path.join(__dirname, 'convert-vscode-theme.cjs');
  for (const flags of [[], ['--quiet'], ['--json']]) {
    const result = spawnSync(process.execPath, [script, ...flags], { encoding: 'utf8', input: '' });
    assert.equal(result.status, 1);
    if (flags.includes('--json')) {
      assert.match(JSON.parse(result.stdout).error, /Usage:/);
      assert.equal(result.stderr, '');
    } else {
      assert.match(result.stderr, /Usage:/);
      assert.equal(result.stdout, '');
    }
  }
});
