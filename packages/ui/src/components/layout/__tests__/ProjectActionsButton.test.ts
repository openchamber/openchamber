/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2723
 *
 * Auto-discover should be hidden from the project actions menu when no dev
 * server can be detected, but in-progress Auto-discover runs must keep their
 * URL-watch behavior and the click path must still perform fresh detection.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, '..', 'ProjectActionsButton.tsx'),
  'utf-8',
);

describe('issue #2723: Auto-discover hidden when no dev server is detectable', () => {
  test('the visibility gate requires a positive dev-server detection on desktop', () => {
    expect(source).toContain('const canUseAutoDiscover = !isMobile && devServerDetected === true;');

    const displayActionsIndex = source.indexOf('const displayActions = React.useMemo(');
    expect(displayActionsIndex).toBeGreaterThan(-1);
    const displayActionsMemo = source.slice(displayActionsIndex, displayActionsIndex + 400);
    expect(displayActionsMemo).toContain('canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions');
  });

  test('loadActions resets devServerDetected to null when the directory changes', () => {
    const loadActionsStart = source.indexOf('const loadActions = React.useCallback(async () => {');
    expect(loadActionsStart).toBeGreaterThan(-1);
    const loadActionsEnd = source.indexOf('  }, [directory, stableProjectRef]);', loadActionsStart);
    expect(loadActionsEnd).toBeGreaterThan(loadActionsStart);
    const loadActions = source.slice(loadActionsStart, loadActionsEnd);

    expect(loadActions).toContain("const detectedDirectory = normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');");
    expect(loadActions).toContain('detectionDirectoryRef.current !== detectedDirectory');
    expect(loadActions).toContain('setDevServerDetected(null);');

    const resetIndex = loadActions.indexOf('setDevServerDetected(null);');
    const scriptsIndex = loadActions.indexOf('readPackageJsonScripts(detectedDirectory)');
    expect(resetIndex).toBeGreaterThan(-1);
    expect(scriptsIndex).toBeGreaterThan(resetIndex);
  });

  test('loadActions detects the dev server using the current directory and actions', () => {
    const loadActionsStart = source.indexOf('const loadActions = React.useCallback(async () => {');
    expect(loadActionsStart).toBeGreaterThan(-1);
    const loadActionsEnd = source.indexOf('  }, [directory, stableProjectRef]);', loadActionsStart);
    expect(loadActionsEnd).toBeGreaterThan(loadActionsStart);
    const loadActions = source.slice(loadActionsStart, loadActionsEnd);

    expect(loadActions).toContain('readPackageJsonScripts(detectedDirectory)');
    expect(loadActions).toContain('detectDevServerCommand(detectedDirectory, filtered, scripts)');

    const scriptsIndex = loadActions.indexOf('readPackageJsonScripts(detectedDirectory)');
    const firstGuardAfterScripts = loadActions.indexOf('if (loadRequestIdRef.current !== requestId) {', scriptsIndex);
    const devServerIndex = loadActions.indexOf('detectDevServerCommand(detectedDirectory, filtered, scripts)');
    const secondGuardAfterDevServer = loadActions.indexOf('if (loadRequestIdRef.current !== requestId) {', devServerIndex);
    const setDetectedIndex = loadActions.indexOf('setDevServerDetected(devServer !== null);');

    expect(firstGuardAfterScripts).toBeGreaterThan(scriptsIndex);
    expect(devServerIndex).toBeGreaterThan(firstGuardAfterScripts);
    expect(secondGuardAfterDevServer).toBeGreaterThan(devServerIndex);
    expect(setDetectedIndex).toBeGreaterThan(secondGuardAfterDevServer);
  });

  test('selection-clearing effect waits while dev-server detection is pending', () => {
    const effectStart = source.indexOf('React.useEffect(() => {\n    if (devServerDetected === null) {');
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = source.indexOf('  }, [actions, canUseAutoDiscover, devServerDetected, selectedActionId]);', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effect = source.slice(effectStart, effectEnd);

    const pendingReturnIndex = effect.indexOf('if (devServerDetected === null) {');
    const clearIndex = effect.indexOf('setSelectedActionId(null);');
    expect(pendingReturnIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(pendingReturnIndex);
  });

  test('monitor effect keeps watching Auto-discover runs even when the action is hidden from the menu', () => {
    const monitorStart = source.indexOf('const monitorRuns = () => {');
    expect(monitorStart).toBeGreaterThan(-1);
    const monitorEnd = source.indexOf(
      '  }, [autoDiscoverAction, displayActions, openContextPreview, openExternal, projectActionRuns, removeProjectActionRun, setTabPreviewUrl, t, updateProjectActionRunStatus]);',
      monitorStart,
    );
    expect(monitorEnd).toBeGreaterThan(monitorStart);
    const monitor = source.slice(monitorStart, monitorEnd);

    expect(monitor).toContain('const action = displayActions.find((item) => item.id === entry.actionId)');
    expect(monitor).toContain('?? (entry.actionId === AUTO_DISCOVER_ACTION_ID ? autoDiscoverAction : undefined);');
  });

  test('click path still runs fresh detection and fails with the no-dev-server error', () => {
    const runActionStart = source.indexOf('const runAction = React.useCallback(async (action: OpenChamberProjectAction) => {');
    expect(runActionStart).toBeGreaterThan(-1);
    const runActionEnd = source.indexOf('  }, [', runActionStart);
    expect(runActionEnd).toBeGreaterThan(runActionStart);
    const runAction = source.slice(runActionStart, runActionEnd);

    expect(runAction).toContain('detectDevServerCommand(normalizedDirectory, actionsState.actions, scripts)');
    expect(runAction).toContain("t('contextPanel.preview.noDevServer')");
  });
});
