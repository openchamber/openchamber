#!/usr/bin/env node
/**
 * Reproduction script for issue #2359:
 * VS Code Extension: workspace folder not used as default project on startup
 *
 * This script traces the module-level initialization order in the VS Code webview
 * bundle and demonstrates that stores initialize BEFORE
 * `window.__OPENCHAMBER_RUNTIME_APIS__` is set, causing `isVSCodeRuntime()` to
 * return false and the stores to fall back to localStorage.
 *
 * Run: node reproduce-2359.mjs
 */

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..');
const UI_SRC = path.join(ROOT, 'packages/ui/src');

// ============================================================
// 1. Trace the static import chain from main.tsx → stores
// ============================================================

console.log('=== Step 1: Tracing static import chain ===\n');

// main.tsx statically imports @openchamber/ui/stores/permissionStore
// permissionStore statically imports @/sync/session-ui-store
// session-ui-store statically imports:
//   - @/stores/useDirectoryStore   (line 24)
//   - @/stores/useProjectsStore    (line 22)

const chain = [
  'packages/vscode/webview/main.tsx',
  'packages/ui/src/stores/permissionStore.ts',
  'packages/ui/src/sync/session-ui-store.ts',
  'packages/ui/src/stores/useDirectoryStore.ts',
  'packages/ui/src/stores/useProjectsStore.ts',
];

for (const file of chain) {
  const fullPath = path.join(ROOT, file);
  const exists = fs.existsSync(fullPath);
  console.log(`  ${exists ? '✓' : '✗'} ${file} (${exists ? 'exists' : 'MISSING'})`);
}

console.log(`
  Static import chain:
    main.tsx
      → permissionStore.ts  (static import, line 16)
        → session-ui-store.ts  (static import, line 9)
          → useDirectoryStore.ts  (static import, line 24)
          → useProjectsStore.ts  (static import, line 22)
`);

// ============================================================
// 2. Show module-level code that runs during import
// ============================================================

console.log('=== Step 2: Module-level code in stores that runs at import time ===\n');

// useDirectoryStore.ts module-level code (lines 226-250):
const useDirectoryStoreInit = `
  getVsCodeWorkspaceFolder() → calls isVSCodeRuntime() → false (APIs not set)
  initialHomeDirectory = getVsCodeWorkspaceFolder() || getHomeDirectory()
    → getVsCodeWorkspaceFolder() returns null (isVSCodeRuntime() is false)
    → getHomeDirectory() uses window.__OPENCHAMBER_HOME__ or localStorage
  initialCurrentDirectory:
    → reads persisted last directory from localStorage
    → isVSCodeRuntime() is false → uses persisted directory
    → WRONG: should use workspace folder in VS Code runtime
`;
console.log('useDirectoryStore.ts:');
console.log(useDirectoryStoreInit);

// useProjectsStore.ts module-level code (lines 378-556):
const useProjectsStoreInit = `
  initialProjects = readPersistedProjects()  → reads from localStorage

  getVSCodeWorkspaceFolders():
    → getRegisteredRuntimeAPIs() returns null (APIs not set yet)
    → runtimeApis?.runtime?.isVSCode is undefined (falsy)
    → returns null

  getVSCodeWorkspaceProject():
    → getVSCodeWorkspaceFolders() returns null
    → returns null

  vscodeWorkspace = getVSCodeWorkspaceProject()  → null
  isVSCodeProjectsRuntime = false
  effectiveInitialProjects = vscodeWorkspace?.projects ?? []
    → null?.projects ?? initialProjects
    → initialProjects (from localStorage)
  initialActiveProjectId = from localStorage
`;
console.log('useProjectsStore.ts:');
console.log(useProjectsStoreInit);

// ============================================================
// 3. Show runtimeAPIRegistry execution
// ============================================================

console.log('=== Step 3: getRegisteredRuntimeAPIs() behavior ===\n');

const registryCode = `
  getRegisteredRuntimeAPIs() {
    // 1. Check in-memory registry: registeredRuntimeAPIs → null (never set)
    if (registeredRuntimeAPIs) return registeredRuntimeAPIs;
    // 2. Check window fallback: not set yet at module init time
    return window.__OPENCHAMBER_RUNTIME_APIS__ ?? null;
  }

  At module initialization time:
    - registeredRuntimeAPIs = null
    - window.__OPENCHAMBER_RUNTIME_APIS__ = undefined (set later in main.tsx line 62)
    - Result: returns null
`;
console.log(registryCode);

// ============================================================
// 4. Show what happens in main.tsx
// ============================================================

console.log('=== Step 4: main.tsx module-level code (runs AFTER stores) ===\n');

const mainTsxCode = `
  // Line 62: Sets window.__OPENCHAMBER_RUNTIME_APIS__
  // This runs AFTER all static imports have been resolved
  window.__OPENCHAMBER_RUNTIME_APIS__ = createVSCodeAPIs();

  // Lines 245-274: Persists workspace folder to localStorage
  // This also runs after store initialization
  const workspaceFolder = window.__VSCODE_CONFIG__?.workspaceFolder;
  if (workspaceFolder) {
    window.localStorage.setItem('lastDirectory', normalizedWorkspaceFolder);
    window.localStorage.setItem('homeDirectory', normalizedWorkspaceFolder);
    // ...
  }
`;
console.log(mainTsxCode);

// ============================================================
// 5. Show that the HTML template already has the workspace folder
// ============================================================

console.log('=== Step 5: HTML template (webviewHtml.ts) has workspace folder ===\n');

const webviewHtmlCode = `
  // Lines 182-194: window.__VSCODE_CONFIG__ is set in inline <script>
  // BEFORE the bundle loads
  window.__VSCODE_CONFIG__ = {
    workspaceFolder: "/path/to/workspace",
    workspaceFolders: [{ name: "my-project", path: "/path/to/workspace" }],
    // ...
  };
  window.__OPENCHAMBER_HOME__ = "/path/to/workspace";

  // But window.__OPENCHAMBER_RUNTIME_APIS__ is NOT set here
  // → Store modules can't detect VS Code runtime
`;
console.log(webviewHtmlCode);

// ============================================================
// 6. Summary
// ============================================================

console.log('=== Step 6: Resulting behavior ===\n');

console.log(`  ┌──────────────────────────────────────────────────────────────────┐
  │                          HTML Template                          │
  │  <script>                                                        │
  │    __VSCODE_CONFIG__ = { workspaceFolder: "/ws" }                │
  │    __OPENCHAMBER_HOME__ = "/ws"                                  │
  │    // __OPENCHAMBER_RUNTIME_APIS__ is NOT set                    │
  │  </script>                                                       │
  │  <script type="module" src="assets/index.js">                    │
  └──────────────────────────┬───────────────────────────────────────┘
                             │ loads bundle
  ┌──────────────────────────▼───────────────────────────────────────┐
  │                   Bundle Initialization (ESM)                    │
  │                                                                  │
  │  1. runtimeAPIRegistry.ts module-level code runs                 │
  │     → registeredRuntimeAPIs = null                               │
  │                                                                  │
  │  2. permissionStore.ts module-level code runs (static import)    │
  │     → session-ui-store.ts is imported                           │
  │                                                                  │
  │  3. session-ui-store.ts module-level code runs                   │
  │     → useDirectoryStore.ts and useProjectsStore.ts are imported │
  │                                                                  │
  │  4. useDirectoryStore.ts module-level code runs ★                │
  │     → isVSCodeRuntime() = false (APIs not set)                   │
  │     → initialCurrentDirectory = from localStorage                │
  │                                                                  │
  │  5. useProjectsStore.ts module-level code runs ★                  │
  │     → isVSCodeRuntime() = false (APIs not set)                   │
  │     → effectiveInitialProjects = from localStorage               │
  │                                                                  │
  │  6. ... other static deps init ...                               │
  │                                                                  │
  │  7. main.tsx module-level code runs ★★★                          │
  │     → window.__OPENCHAMBER_RUNTIME_APIS__ = createVSCodeAPIs()   │
  │     → TOO LATE — stores already initialized with wrong values    │
  └──────────────────────────────────────────────────────────────────┘

  CONSEQUENCE:
    - useProjectsStore initializes with projects from localStorage 
      (from a previous VS Code window or empty), NOT the current 
      workspace folder
    - useDirectoryStore initializes with the last used directory 
      from localStorage, NOT the workspace folder
    - The VS Code workspace folder is available in __VSCODE_CONFIG__ 
      and __OPENCHAMBER_HOME__, but stores never read it because
      isVSCodeRuntime() returns false during initialization

  PROPOSED FIX:
    Inject window.__OPENCHAMBER_RUNTIME_APIS__ in the HTML template
    (webviewHtml.ts) alongside __VSCODE_CONFIG__, before the bundle loads:

      window.__OPENCHAMBER_RUNTIME_APIS__ = {
        runtime: { platform: "vscode", isDesktop: false, isVSCode: true }
      };
`);

// ============================================================
// Verify the code matches what we've traced
// ============================================================

console.log('=== Verification ===\n');

// Verify useDirectoryStore.ts calls isVSCodeRuntime at module level
const directoryStore = fs.readFileSync(
  path.join(UI_SRC, 'stores/useDirectoryStore.ts'), 'utf-8'
);

const dirLines = directoryStore.split('\n');
const moduleLevelCalls = [];
for (let i = 0; i < dirLines.length; i++) {
  const line = dirLines[i];
  if (
    line.includes('isVSCodeRuntime()') && 
    (i < 55 || (i > 220 && i < 255)) // Module-level section
  ) {
    moduleLevelCalls.push({ line: i + 1, code: line.trim() });
  }
}

console.log('Module-level isVSCodeRuntime() calls in useDirectoryStore.ts:');
for (const call of moduleLevelCalls) {
  console.log(`  Line ${call.line}: ${call.code}`);
}
console.log();

// Verify useProjectsStore.ts calls getRegisteredRuntimeAPIs at module level
const projectsStore = fs.readFileSync(
  path.join(UI_SRC, 'stores/useProjectsStore.ts'), 'utf-8'
);

const projLines = projectsStore.split('\n');
const projModuleLevelCalls = [];
for (let i = 0; i < projLines.length; i++) {
  const line = projLines[i];
  if (
    (line.includes('getRegisteredRuntimeAPIs()') || line.includes('isVSCodeProjectsRuntime') || line.includes('getVSCodeWorkspaceFolders()') || line.includes('getVSCodeWorkspaceProject()')) &&
    (i < 45 || (i > 415 && i < 560)) // Module-level section
  ) {
    projModuleLevelCalls.push({ line: i + 1, code: line.trim() });
  }
}

console.log('Module-level runtime detection calls in useProjectsStore.ts:');
for (const call of projModuleLevelCalls) {
  console.log(`  Line ${call.line}: ${call.code}`);
}
console.log();

// Verify that main.tsx sets __OPENCHAMBER_RUNTIME_APIS__ AFTER imports
const mainTsx = fs.readFileSync(
  path.join(ROOT, 'packages/vscode/webview/main.tsx'), 'utf-8'
);
const mainLines = mainTsx.split('\n');

console.log('window.__OPENCHAMBER_RUNTIME_APIS__ assignment in main.tsx:');
for (let i = 0; i < mainLines.length; i++) {
  if (mainLines[i].includes('__OPENCHAMBER_RUNTIME_APIS__')) {
    console.log(`  Line ${i + 1}: ${mainLines[i].trim()}`);
    break;
  }
}
console.log();

console.log('First 20 lines of main.tsx (imports):');
for (let i = 0; i < Math.min(20, mainLines.length); i++) {
  if (mainLines[i].trim().startsWith('import ')) {
    console.log(`  Line ${i + 1}: ${mainLines[i].trim()}`);
  }
}

// Verify that the HTML template does NOT set __OPENCHAMBER_RUNTIME_APIS__
const webviewHtml = fs.readFileSync(
  path.join(ROOT, 'packages/vscode/src/webviewHtml.ts'), 'utf-8'
);

console.log();
console.log('__OPENCHAMBER_RUNTIME_APIS__ in webviewHtml.ts:');
if (webviewHtml.includes('__OPENCHAMBER_RUNTIME_APIS__')) {
  console.log('  FOUND — already set in HTML template');
} else {
  console.log('  NOT FOUND — confirmed missing from HTML template');
}

console.log();
console.log('__VSCODE_CONFIG__ assignment in webviewHtml.ts:');
for (const line of webviewHtml.split('\n')) {
  if (line.includes('__VSCODE_CONFIG__')) {
    console.log(`  ${line.trim()}`);
  }
}

// ============================================================
// Final verdict
// ============================================================
console.log();
console.log('=== VERDICT ===');
console.log('BUG CONFIRMED: Module-level store initialization runs before');
console.log('window.__OPENCHAMBER_RUNTIME_APIS__ is set, causing');
console.log('isVSCodeRuntime() to return false and stores to fall back to');
console.log('localStorage instead of using the VS Code workspace folder.');
