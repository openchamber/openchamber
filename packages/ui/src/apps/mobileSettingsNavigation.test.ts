import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from '@/stores/useUIStore';
import { connectMobileSettingsNavigation, type MobileSettingsStage } from './mobileSettingsNavigation';

const originalUI = useUIStore.getState();
let disconnect: (() => void) | undefined;

afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  useUIStore.setState(originalUI, true);
});

const connect = (): MobileSettingsStage[] => {
  const opened: MobileSettingsStage[] = [];
  disconnect = connectMobileSettingsNavigation(['general', 'integrations'], (stage) => { opened.push(stage); });
  return opened;
};

describe('mobile Settings navigation', () => {
  test('opens the Settings surface on the requested page and clears the dialog flag', () => {
    useUIStore.setState({ isSettingsDialogOpen: false });
    const opened = connect();
    useUIStore.getState().setSettingsPage('integrations');
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(opened).toEqual(['page-content']);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
  });

  test('opens the page list when no page or a page the phone hides is requested', () => {
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'home' });
    const opened = connect();
    useUIStore.getState().setSettingsDialogOpen(true);
    useUIStore.getState().setSettingsPage('shortcuts');
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(opened).toEqual(['nav', 'nav']);
  });

  test('handles a request made before it connected, and none after it disconnects', () => {
    useUIStore.setState({ isSettingsDialogOpen: true, settingsPage: 'general' });
    const opened = connect();
    expect(opened).toEqual(['page-content']);
    disconnect?.();
    disconnect = undefined;
    useUIStore.getState().setSettingsDialogOpen(true);
    expect(opened).toEqual(['page-content']);
  });
});
