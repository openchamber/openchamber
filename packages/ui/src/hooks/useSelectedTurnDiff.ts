import React from 'react';

type TurnDiffRequest = { file: string; sessionId: string | null; turnId?: string; panelSessionId: string | null } | null;
type SelectedTurn = { sessionId: string; turnId?: string; panelSessionId: string | null };

export function useSelectedTurnDiff({
  visible, isTurnScope, currentSessionId, request,
}: {
  visible: boolean;
  isTurnScope: boolean;
  currentSessionId: string | null;
  request: TurnDiffRequest;
}) {
  const [selectedTurn, setSelectedTurn] = React.useState<SelectedTurn | null>(null);
  const ownRequest = request && request.panelSessionId === currentSessionId ? request : null;
  React.useEffect(() => {
    if (!isTurnScope) {
      setSelectedTurn(null);
    } else if (visible && ownRequest) {
      setSelectedTurn(ownRequest.sessionId
        ? { sessionId: ownRequest.sessionId, turnId: ownRequest.turnId, panelSessionId: ownRequest.panelSessionId }
        : null);
    }
  }, [visible, isTurnScope, ownRequest]);

  const ownSelected = selectedTurn && selectedTurn.panelSessionId === currentSessionId ? selectedTurn : null;
  const active = visible && isTurnScope ? ownRequest ?? ownSelected : null;
  const reset = React.useCallback(() => setSelectedTurn(null), []);
  return {
    turnId: active?.turnId,
    turnSessionId: active?.sessionId ?? currentSessionId,
    reset,
  };
}
