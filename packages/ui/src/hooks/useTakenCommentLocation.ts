import React from 'react';

import { isCommentLocationFor, type CommentLocationRequest } from '@/lib/commentLocation';
import { useUIStore } from '@/stores/useUIStore';

export function useTakenCommentLocation(directory: string | null | undefined, active: boolean) {
  const pending = useUIStore((state) => state.pendingCommentLocation);
  const [jump, setJump] = React.useState<CommentLocationRequest | null>(null);

  React.useEffect(() => {
    if (!active || !pending || !isCommentLocationFor(pending, directory)) return;
    useUIStore.getState().setPendingCommentLocation(null);
    setJump(pending);
  }, [active, directory, pending]);

  React.useEffect(() => {
    if (!active) setJump(null);
  }, [active]);

  const done = React.useCallback(() => setJump(null), []);
  return { jump: jump && isCommentLocationFor(jump, directory) ? jump : null, done };
}
