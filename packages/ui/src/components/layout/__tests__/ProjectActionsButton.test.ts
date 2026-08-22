/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2723
 *
 * Auto-discover should be hidden from the project actions menu when no dev
 * server can be detected, but in-progress Auto-discover runs must keep their
 * URL-watch behavior, stop affordance, and the click path must still perform
 * fresh detection. When a project has no configured actions and Auto-discover
 * is hidden, the control still renders as a dropdown with the Add new action
 * settings entry.
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
    expect(displayActionsMemo).toContain('shouldShowAutoDiscover ? [autoDiscoverAction, ...actions] : actions');
  });

  test('loadActions resets devServerDetected to null only when the directory changes', () => {
    const loadActionsStart = source.indexOf('const loadActions = React.useCallback(async () => {');
    expect(loadActionsStart).toBeGreaterThan(-1);
    const loadActionsEnd = source.indexOf('  }, [directory, stableProjectRef]);', loadActionsStart);
    expect(loadActionsEnd).toBeGreaterThan(loadActionsStart);
    const loadActions = source.slice(loadActionsStart, loadActionsEnd);

    const directoryChangeBranchStart = loadActions.indexOf('if (detectionDirectoryRef.current !== detectedDirectory) {');
    expect(directoryChangeBranchStart).toBeGreaterThan(-1);
    const directoryChangeBranchEnd = loadActions.indexOf('}', directoryChangeBranchStart);
    expect(directoryChangeBranchEnd).toBeGreaterThan(directoryChangeBranchStart);
    const directoryChangeBranch = loadActions.slice(directoryChangeBranchStart, directoryChangeBranchEnd + 1);

    expect(directoryChangeBranch).toContain('detectionDirectoryRef.current !== detectedDirectory');
    expect(directoryChangeBranch).toContain('detectionDirectoryRef.current = detectedDirectory;');
    expect(directoryChangeBranch).toContain('setDevServerDetected(null);');

    const refAssignmentIndex = directoryChangeBranch.indexOf('detectionDirectoryRef.current = detectedDirectory;');
    const resetIndex = directoryChangeBranch.indexOf('setDevServerDetected(null);');
    expect(refAssignmentIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(refAssignmentIndex);

    const resetIndexInLoadActions = loadActions.indexOf('setDevServerDetected(null);');
    const scriptsIndex = loadActions.indexOf('readPackageJsonScripts(detectedDirectory)');
    expect(resetIndexInLoadActions).toBeGreaterThan(-1);
    expect(scriptsIndex).toBeGreaterThan(resetIndexInLoadActions);
  });

  test('loadActions detects the dev server using the current directory and actions and guards stale requests', () => {
    const loadActionsStart = source.indexOf('const loadActions = React.useCallback(async () => {');
    expect(loadActionsStart).toBeGreaterThan(-1);
    const loadActionsEnd = source.indexOf('  }, [directory, stableProjectRef]);', loadActionsStart);
    expect(loadActionsEnd).toBeGreaterThan(loadActionsStart);
    const loadActions = source.slice(loadActionsStart, loadActionsEnd);

    expect(loadActions).toContain('readPackageJsonScripts(detectedDirectory)');
    expect(loadActions).toContain('detectDevServerCommand(detectedDirectory, filtered, scripts)');

    const scriptsIndex = loadActions.indexOf('readPackageJsonScripts(detectedDirectory)');
    const firstGuardStart = loadActions.indexOf('if (loadRequestIdRef.current !== requestId) {', scriptsIndex);
    const firstGuardEnd = loadActions.indexOf('}', firstGuardStart);
    const devServerIndex = loadActions.indexOf('detectDevServerCommand(detectedDirectory, filtered, scripts)');
    const secondGuardStart = loadActions.indexOf('if (loadRequestIdRef.current !== requestId) {', devServerIndex);
    const secondGuardEnd = loadActions.indexOf('}', secondGuardStart);
    const setDetectedIndex = loadActions.indexOf('setDevServerDetected(devServer !== null);');

    expect(firstGuardStart).toBeGreaterThan(scriptsIndex);
    expect(firstGuardEnd).toBeGreaterThan(firstGuardStart);
    expect(loadActions.slice(firstGuardStart, firstGuardEnd + 1)).toContain('return;');
    expect(devServerIndex).toBeGreaterThan(firstGuardEnd);
    expect(secondGuardStart).toBeGreaterThan(devServerIndex);
    expect(secondGuardEnd).toBeGreaterThan(secondGuardStart);
    expect(loadActions.slice(secondGuardStart, secondGuardEnd + 1)).toContain('return;');
    expect(setDetectedIndex).toBeGreaterThan(secondGuardEnd);
  });

  test('selection-clearing effect waits while dev-server detection is pending', () => {
    const effectStart = source.indexOf('React.useEffect(() => {\n    if (devServerDetected === null) {');
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = source.indexOf('  }, [actions, devServerDetected, selectedActionId, shouldShowAutoDiscover]);', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effect = source.slice(effectStart, effectEnd);

    const pendingReturnIndex = effect.indexOf('if (devServerDetected === null) {');
    const pendingGuardEnd = effect.indexOf('}', pendingReturnIndex);
    const clearIndex = effect.indexOf('setSelectedActionId(null);');
    expect(pendingReturnIndex).toBeGreaterThan(-1);
    expect(pendingGuardEnd).toBeGreaterThan(pendingReturnIndex);
    expect(effect.slice(pendingReturnIndex, pendingGuardEnd + 1)).toContain('return;');
    expect(clearIndex).toBeGreaterThan(pendingGuardEnd);
  });

  test('active Auto-discover runs keep the stop affordance even when hidden from the menu', () => {
    expect(source).toContain('const shouldShowAutoDiscover = canUseAutoDiscover || autoDiscoverRunActive;');

    const autoDiscoverRunActiveStart = source.indexOf('const autoDiscoverRunActive = React.useMemo(() => {');
    expect(autoDiscoverRunActiveStart).toBeGreaterThan(-1);
    const autoDiscoverRunActiveEnd = source.indexOf('  }, [normalizedDirectory, projectActionRuns]);', autoDiscoverRunActiveStart);
    expect(autoDiscoverRunActiveEnd).toBeGreaterThan(autoDiscoverRunActiveStart);
    const autoDiscoverRunActive = source.slice(autoDiscoverRunActiveStart, autoDiscoverRunActiveEnd);

    expect(autoDiscoverRunActive).toContain('toProjectActionRunKey(normalizedDirectory, AUTO_DISCOVER_ACTION_ID)');
    for (const status of ['running', 'waiting-for-preview', 'stopping']) {
      expect(autoDiscoverRunActive).toContain(`run?.status === '${status}'`);
    }

    const effectStart = source.indexOf('React.useEffect(() => {\n    if (devServerDetected === null) {');
    const effect = source.slice(effectStart, effectStart + 600);
    expect(effect).toContain('selectedActionId === AUTO_DISCOVER_ACTION_ID && shouldShowAutoDiscover');
    expect(effect).not.toContain('selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover');
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

describe('issue #2743 follow-up: empty project actions keep the dropdown entry', () => {
  test('the early return for an empty actions list is removed and the resolved selection still exists', () => {
    expect(source).not.toContain('if (!resolvedSelected) {');
    expect(source).toContain('const resolvedSelected = selectedAction ?? displayActions[0] ?? null;');
  });

  test('the resolved-selected downstream values stay null-safe so rendering can continue without an action', () => {
    expect(source).toContain("const selectedIconKey = (resolvedSelected?.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;");
    expect(source).toContain('const selectedIconName = resolvedSelected?.id === AUTO_DISCOVER_ACTION_ID');
    expect(source).toContain('const selectedRunKey = resolvedSelected ? toProjectActionRunKey(normalizedDirectory, resolvedSelected.id) : null;');
    expect(source).toContain('const selectedRunning = selectedRunKey ? projectActionRuns[selectedRunKey] : null;');
    expect(source).toContain('const isAutoDiscoverSelected = resolvedSelected?.id === AUTO_DISCOVER_ACTION_ID;');
  });

  test('the primary action button is guarded by the resolved-selected conditional in both variants', () => {
    const guardMarker = '{resolvedSelected ? (';
    const firstGuardIndex = source.indexOf(guardMarker);
    expect(firstGuardIndex).toBeGreaterThan(-1);
    const secondGuardIndex = source.indexOf(guardMarker, firstGuardIndex + guardMarker.length);
    expect(secondGuardIndex).toBeGreaterThan(firstGuardIndex);
    expect(source.indexOf(guardMarker, secondGuardIndex + guardMarker.length)).toBe(-1);
  });

  test('the preview button also requires a resolved selection in both variants', () => {
    const previewGuardMarker = '{resolvedSelected && showSelectedPreviewButton ? (';
    const firstPreviewGuardIndex = source.indexOf(previewGuardMarker);
    expect(firstPreviewGuardIndex).toBeGreaterThan(-1);
    const secondPreviewGuardIndex = source.indexOf(previewGuardMarker, firstPreviewGuardIndex + previewGuardMarker.length);
    expect(secondPreviewGuardIndex).toBeGreaterThan(firstPreviewGuardIndex);
    expect(source.indexOf(previewGuardMarker, secondPreviewGuardIndex + previewGuardMarker.length)).toBe(-1);
  });

  test('the dropdown separator renders only when there are actions in both variants', () => {
    const separatorMarker = '{displayActions.length > 0 ? <DropdownMenuSeparator /> : null}';
    const firstSeparatorIndex = source.indexOf(separatorMarker);
    expect(firstSeparatorIndex).toBeGreaterThan(-1);
    const secondSeparatorIndex = source.indexOf(separatorMarker, firstSeparatorIndex + separatorMarker.length);
    expect(secondSeparatorIndex).toBeGreaterThan(firstSeparatorIndex);
    expect(source.indexOf(separatorMarker, secondSeparatorIndex + separatorMarker.length)).toBe(-1);
  });

  test('the Add new action dropdown item renders outside the resolved-selected guard in both variants', () => {
    const addNewActionMarker = "t('projectActions.actions.addNewAction')";
    const firstAddNewActionIndex = source.indexOf(addNewActionMarker);
    expect(firstAddNewActionIndex).toBeGreaterThan(-1);
    const secondAddNewActionIndex = source.indexOf(addNewActionMarker, firstAddNewActionIndex + addNewActionMarker.length);
    expect(secondAddNewActionIndex).toBeGreaterThan(firstAddNewActionIndex);
    expect(source.indexOf(addNewActionMarker, secondAddNewActionIndex + addNewActionMarker.length)).toBe(-1);

    const compactGuardCloseMarker = '</Tooltip>\n        ) : null}';
    const firstCompactGuardCloseIndex = source.indexOf(compactGuardCloseMarker);
    expect(firstCompactGuardCloseIndex).toBeGreaterThan(-1);
    const nonCompactGuardCloseMarker = '</Tooltip>\n      ) : null}';
    const nonCompactGuardCloseIndex = source.indexOf(nonCompactGuardCloseMarker, firstCompactGuardCloseIndex);
    expect(nonCompactGuardCloseIndex).toBeGreaterThan(firstCompactGuardCloseIndex);

    const triggerMarker = "t('projectActions.actions.chooseActionAria')";
    const firstTriggerIndex = source.indexOf(triggerMarker);
    expect(firstTriggerIndex).toBeGreaterThan(-1);

    expect(firstAddNewActionIndex).toBeGreaterThan(firstCompactGuardCloseIndex);
    expect(secondAddNewActionIndex).toBeGreaterThan(nonCompactGuardCloseIndex);
    expect(firstAddNewActionIndex).toBeGreaterThan(firstTriggerIndex);
  });
});
