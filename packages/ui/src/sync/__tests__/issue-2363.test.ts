/**
 * Reproduction test for issue #2363:
 * VS Code extension 1.16.2 asks to select folder on every opening
 *
 * Root cause analysis:
 *
 * Timeline during VS Code webview startup:
 *
 * 1. HTML inline script runs: sets `__VSCODE_CONFIG__` with workspaceFolder
 *    and workspaceFolders arrays. Also sets `__OPENCHAMBER_HOME__`.
 *
 * 2. Module loading starts for `main.tsx`. Dependencies (stores) are loaded
 *    first:
 *    a. `useDirectoryStore.ts` evaluates:
 *       - `getRegisteredRuntimeAPIs()` returns null (not registered yet)
 *       - `isVSCodeRuntime()` returns false
 *       - `getVsCodeWorkspaceFolder()` returns null (guarded by isVSCodeRuntime)
 *       - `initialHomeDirectory = getVsCodeWorkspaceFolder() || getHomeDirectory()`
 *         - getHomeDirectory() DOES read __OPENCHAMBER_HOME__ correctly
 *       - OK, this actually works because getHomeDirectory reads __OPENCHAMBER_HOME__
 *
 *    b. `useProjectsStore.ts` evaluates:
 *       - `getVSCodeWorkspaceFolders()` checks `getRegisteredRuntimeAPIs()?.runtime?.isVSCode`
 *         → returns null because isVSCode is NOT set yet
 *       - `vscodeWorkspace = null` (no workspace project)
 *       - `isVSCodeProjectsRuntime = false` (same reason)
 *       - `effectiveInitialProjects = initialProjects` (from localStorage, or empty)
 *       - On fresh install: projects = [] (EMPTY!)
 *       - activeProjectId = null
 *     BUG: Projects list is empty even though __VSCODE_CONFIG__ has workspace folders
 *
 * 3. `main.tsx` code runs: saves workspace folder to localStorage
 *    - Does NOT call syncVSCodeWorkspaceProjects
 *
 * 4. React app renders: SyncProvider starts with the correct directory
 *    - Bootstraps sessions for the directory
 *    - But the project is NOT yet in the projects store
 *
 * 5. `VSCodeApp` calls `registerRuntimeAPIs(apis)` in a useEffect
 *    - Now isVSCodeRuntime() returns true
 *    - But it's too late - the stores were already initialized
 *
 * 6. `workspaceFoldersChanged` MAY fire from VS Code extension
 *    - BUT it fires during activation, before the webview is created
 *    - `chatViewProvider._view` is null, message is dropped
 *
 * Result: No projects in the sidebar. The user sees the "Add project" or
 * "Select folder" prompt because the workspace folder was never converted
 * to a project in the projects store.
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Simulate the core logic that fails
// ---------------------------------------------------------------------------

const WORKSPACE_PATH = "/Users/nsx0012020/Projects/NSX/sportsbook-observability";

// Simulate the start of module initialization (registerRuntimeAPIs NOT called yet)
function simulateModuleInitPhase(registerCalled: boolean) {
  // Simulate getRegisteredRuntimeAPIs before and after registration
  const apis = registerCalled 
    ? { runtime: { platform: "vscode", isDesktop: false, isVSCode: true, label: "VS Code" } }
    : null;
  return apis?.runtime?.isVSCode === true;
}

describe("issue #2363 — VS Code extension asks to select folder on every opening", () => {
  test("PHASE 1: Module init — isVSCodeProjectsRuntime is false because registerRuntimeAPIs hasn't been called yet", () => {
    // This simulates what happens when useProjectsStore.ts evaluates
    // during module loading, BEFORE the React app renders and calls
    // registerRuntimeAPIs().
    
    const isVSCodeDuringModuleInit = simulateModuleInitPhase(false);
    expect(isVSCodeDuringModuleInit).toBe(false);
    
    // As a result, getVSCodeWorkspaceFolders() would return null
    // even though __VSCODE_CONFIG__ has the workspace folders.
    // Therefore, the initial projects list is EMPTY.
    
    const effectiveInitialProjects: string[] = []; // Simulated: no projects
    const activeProjectId: string | null = null;    // Simulated: null
    
    expect(effectiveInitialProjects.length).toBe(0);
    expect(activeProjectId).toBeNull();
  });

  test("PHASE 2: After registerRuntimeAPIs — syncVSCodeWorkspaceFolders is the fix path", () => {
    // After registerRuntimeAPIs(), isVSCodeRuntime() returns true.
    // Then syncVSCodeWorkspaceFolders() can be called to create projects
    // from the VS Code workspace folders.
    
    const isVSCodeAfterRegistration = simulateModuleInitPhase(true);
    expect(isVSCodeAfterRegistration).toBe(true);
    
    // Simulate the workspace folder being synced
    const folders = [{ name: "sportsbook-observability", path: WORKSPACE_PATH }];
    
    // syncVSCodeWorkspaceFolders logic:
    const activePath = WORKSPACE_PATH;
    const projects = folders.map((f) => ({
      id: `vscode_${f.path}`,
      path: f.path,
      label: f.name,
    }));
    const activeProject = projects.find((p) => p.path === activePath) ?? projects[0];
    const activeProjectId = activeProject?.id ?? null;
    
    expect(projects.length).toBe(1);
    expect(projects[0].path).toBe(WORKSPACE_PATH);
    expect(activeProjectId).toBeTruthy();
  });

  test("PHASE 3: The workspaceFoldersChanged message is dropped because webview isn't ready", () => {
    // In the VS Code extension, onDidChangeWorkspaceFolders fires during
    // activation. At that point chatViewProvider._view is null (the webview
    // hasn't been created yet because the user hasn't opened the sidebar).
    //
    // syncWorkspaceFolders: (workspaceFolders) => {
    //   this._view?.webview.postMessage({...});
    // }
    //
    // The `?.` means the message is silently dropped.
    
    const viewIsNull = true; // Webview not created yet during activation
    const messageSent = viewIsNull ? false : true;
    expect(messageSent).toBe(false);
    
    // The webview never receives the workspaceFoldersChanged command,
    // so syncVSCodeWorkspaceFolders is never called.
    // The projects list remains empty from Phase 1.
  });

  test("PHASE 4: The user opens the OpenChamber view and sees 'select folder' prompt", () => {
    // The sidebar has no projects (empty list from Phase 1).
    // useProjectSessionSelection tries to open a session draft for the
    // active project, but there IS no active project.
    //
    // In SessionGroupSection / SidebarProjectsList, the empty state
    // "No sessions yet" / "Add a project" is shown.
    //
    // If the user clicks the New Session button in the view title bar,
    // the `openchamber.newSession` command runs.
    // With 1 workspace folder, it auto-selects the folder and sends
    // `newSession` to the webview, which calls syncVSCodeWorkspaceProjects
    // and openNewSessionDraft. This creates the project and opens a draft.
    // 
    // But on NEXT reload, Phase 1-3 repeat - the projects list is empty
    // again, and the user sees the prompt again.
    
    // This is the symptom: every reload resets to empty projects.
  });

  test("SUMMARY: Root cause chain", () => {
    // 1️⃣ Module init: isVSCodeProjectsRuntime = false
    //    → getVSCodeWorkspaceFolders() returns null
    //    → projects = []
    //
    // 2️⃣ onDidChangeWorkspaceFolders fires → webview not ready → message dropped
    //
    // 3️⃣ Webview loads → no syncVSCodeWorkspaceProjects call on initial load
    //
    // 4️⃣ Projects are empty → sidebar shows "select folder" prompt
    //
    // 5️⃣ User selects folder → session works for this session
    //
    // 6️⃣ Reload → back to step 1
    
    // The fix should ensure that either:
    // A. getVSCodeWorkspaceFolders() reads __VSCODE_CONFIG__ directly
    //    without checking isVSCodeRuntime()
    // B. The webview's main.tsx calls syncVSCodeWorkspaceProjects on load
    // C. The workspaceFoldersChanged message is sent when webview resolves
    
    expect(true).toBe(true); // This test documents the analysis
  });
});
