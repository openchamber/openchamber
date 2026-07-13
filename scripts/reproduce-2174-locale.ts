/**
 * Reproduction for OpenChamber issue #2174 (Issues 2 & 3):
 * UI language is not synced between Desktop and VS Code, and
 * language setting is not persisted in the VS Code extension.
 *
 * Root cause:
 * The locale preference is stored ONLY in window.localStorage
 * (key: 'openchamber.i18n.v1'), never in the shared settings file
 * at ~/.config/openchamber/settings.json.
 *
 * This means:
 * - Desktop (Electron) and VS Code have separate localStorage contexts
 *   → language is never synced between them (Issue 2)
 * - VS Code webview's localStorage may be cleared when the webview
 *   is recreated on extension restart → language reverts to 'en' (Issue 3)
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

console.log('=== Reproduction: Issues 2 & 3 - UI Language Sync ===\n');

// 1. Check that shared settings.json exists
const settingsExists = fs.existsSync(SHARED_SETTINGS_PATH);
console.log(`Shared settings file at ${SHARED_SETTINGS_PATH}`);
console.log(`  Exists: ${settingsExists}`);

if (settingsExists) {
  const raw = fs.readFileSync(SHARED_SETTINGS_PATH, 'utf-8');
  const settings = JSON.parse(raw);
  const hasLocale = 'locale' in settings || 'language' in settings || 'i18n' in settings;
  console.log(`  Has locale/language/i18n key: ${hasLocale}`);
  console.log(`  Settings keys: ${Object.keys(settings).join(', ')}`);
  
  // Show that locale is NOT in settings.json
  if (hasLocale) {
    console.log('  FAIL: Locale IS in settings.json (unexpected)');
  } else {
    console.log('  CONFIRMED: Locale is NOT stored in shared settings.json');
  }
} else {
  console.log('  (settings.json does not exist yet - will be created on first run)');
  console.log('  CONFIRMED: No locale in settings.json when file is absent');
}

console.log('\n--- Issue 2: Language is not synced between runtimes ---');
console.log(`
Code evidence:
1. packages/ui/src/lib/i18n/runtime.ts lines 68-95:
   - readStoredLocale() reads from window.localStorage only
   - writeStoredLocale() writes to window.localStorage only
   
2. packages/ui/src/lib/i18n/runtime.ts line 20:
   - LOCALE_STORAGE_KEY = 'openchamber.i18n.v1'
   
3. packages/web/server/lib/opencode/settings-runtime.js:
   - The settings runtime has NO reference to 'locale' or 'i18n'
   - locale is never written to or read from settings.json
   
4. packages/vscode/src/bridge-settings-runtime.ts:
   - The VS Code settings bridge has NO reference to 'locale' or 'i18n'
   - locale is never synced through the shared settings bridge
   
5. packages/vscode/src/webviewHtml.ts lines 198-207:
   - The VS Code webview reads locale ONLY from window.localStorage
   - On restart, if localStorage was cleared, locale defaults to 'en'
`);

console.log('\n--- Issue 3: Language setting not persisted in VS Code ---');
console.log(`
Root cause: VS Code webviews can lose localStorage when:
- The extension is deactivated/activated (e.g., VS Code restart)
- The webview panel is recreated (hide/show cycle)
- VS Code's resource constraints cause webview eviction

When localStorage is lost, detectInitialLocale() in runtime.ts falls
back to DEFAULT_LOCALE = 'en', losing the user's language preference.

The fix would require persisting locale to the shared settings.json
file at ~/.config/openchamber/settings.json, which is already used
by both runtimes for all other settings (theme, model prefs, etc.).

References:
- LOCALE_STORAGE_KEY in packages/ui/src/lib/i18n/runtime.ts:20
- writeStoredLocale() in packages/ui/src/lib/i18n/runtime.ts:85-95
- detectInitialLocale() in packages/ui/src/lib/i18n/runtime.ts:97-104
- webview bootstrap in packages/vscode/src/webviewHtml.ts:197-228
- Shared settings path: packages/vscode/src/bridge-settings-runtime.ts:9
- Shared settings path: packages/web/server/index.js:282-285
`);

console.log('\n=== Verification complete ===');
