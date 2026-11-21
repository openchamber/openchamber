import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type ChangesMode = 'working' | 'turn' | 'branch' | 'commit' | 'pr';
export type ChangesRoute =
  | { type: 'list' }
  | { type: 'diff'; path: string; staged: boolean }
  | { type: 'turn'; path: string }
  | { type: 'comparison'; path: string; sourceKey: string }
  | { type: 'walkthrough' };
interface ChangesNavigation {
  ownerKey: string;
  mode: ChangesMode;
  route: ChangesRoute;
  turnId?: string;
  turnSessionId?: string | null;
  turnDirectory?: string | null;
}
export type MobileChangesInitialDiff = {
  path: string;
  staged: boolean;
  scope?: 'turn';
  turnId?: string;
  sessionId?: string | null;
  directory?: string | null;
};

export const LIST_ROUTE: ChangesRoute = { type: 'list' };

type TurnFileRequest = {
  file: string;
  sessionId: string | null;
  directory: string | null;
  panelSessionId: string | null;
  turnId?: string;
  step: 'turn' | 'changes';
  picked: boolean;
  statusReadFor: string | null;
};

const takenTurnRequests = new WeakSet<object>();
const selectedTurnOf = (request: { turnId?: string; sessionId?: string | null; directory?: string | null }) => ({
  turnId: request.turnId, turnSessionId: request.sessionId, turnDirectory: request.directory,
});
export function useMobileChangesNavigation({
  ownerKey, initialDiff, visible,
}: {
  ownerKey: string;
  initialDiff?: MobileChangesInitialDiff | null;
  visible: boolean;
}) {
  const ownerKeyRef = React.useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [navigation, setNavigation] = React.useState<ChangesNavigation>(() => {
    if (initialDiff?.scope === 'turn') {
      return takenTurnRequests.has(initialDiff)
        ? { ownerKey, mode: 'working', route: LIST_ROUTE }
        : { ownerKey, mode: 'turn', route: LIST_ROUTE, ...selectedTurnOf(initialDiff) };
    }
    return {
      ownerKey,
      mode: 'working',
      route: initialDiff?.path ? { type: 'diff', path: initialDiff.path, staged: initialDiff.staged } : LIST_ROUTE,
    };
  });
  const [turnFileRequest, setTurnFileRequest] = React.useState<TurnFileRequest | null>(null);
  const modeOnNewOwner: ChangesMode = turnFileRequest?.step === 'turn' ? 'turn' : 'working';
  const mode = navigation.ownerKey === ownerKey ? navigation.mode : modeOnNewOwner;
  const route = navigation.ownerKey === ownerKey ? navigation.route : LIST_ROUTE;
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const changeMode = React.useCallback((nextMode: ChangesMode) => {
    setTurnFileRequest(null);
    setNavigation({ ownerKey, mode: nextMode, route: LIST_ROUTE });
    setModeMenuOpen(false);
  }, [ownerKey]);
  const setRoute = React.useCallback((nextRoute: ChangesRoute) => {
    setNavigation((current) => current.ownerKey === ownerKey
      ? { ...current, route: nextRoute }
      : { ownerKey, mode: 'working', route: nextRoute });
  }, [ownerKey]);

  React.useEffect(() => {
    setNavigation((current) => {
      if (current.ownerKey === ownerKey) return current;
      const reset: ChangesNavigation = { ownerKey, mode: modeOnNewOwner, route: LIST_ROUTE };
      return turnFileRequest?.step === 'turn' ? { ...reset, ...selectedTurnOf(turnFileRequest) } : reset;
    });
    setModeMenuOpen(false);
  }, [modeOnNewOwner, ownerKey, turnFileRequest]);
  React.useEffect(() => { if (!visible) setModeMenuOpen(false); }, [visible]);

  const turnFileStatusReadRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!initialDiff?.path) return;
    if (initialDiff.scope === 'turn') {
      if (takenTurnRequests.has(initialDiff)) return;
      takenTurnRequests.add(initialDiff);
      turnFileStatusReadRef.current = null;
      const panelSessionId = useSessionUIStore.getState().currentSessionId;
      setTurnFileRequest({
        file: initialDiff.path, sessionId: initialDiff.sessionId ?? panelSessionId, directory: initialDiff.directory ?? null,
        panelSessionId, turnId: initialDiff.turnId, step: 'turn', picked: false, statusReadFor: null,
      });
      setNavigation({ ownerKey: ownerKeyRef.current, mode: 'turn', route: LIST_ROUTE, ...selectedTurnOf(initialDiff) });
      return;
    }
    setTurnFileRequest(null);
    setNavigation({ ownerKey: ownerKeyRef.current, mode: 'working', route: { type: 'diff', path: initialDiff.path, staged: initialDiff.staged } });
  }, [initialDiff]);
  return {
    navigation, setNavigation, turnFileRequest, setTurnFileRequest, mode, route,
    modeMenuOpen, setModeMenuOpen, changeMode, setRoute, turnFileStatusReadRef,
  };
}
