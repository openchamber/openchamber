import React from 'react';

import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { hasAnnotationScreenshot, readAnnotationScreenshot, saveAnnotationScreenshot } from '@/lib/browser/annotationScreenshotStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { EMPTY_INLINE_COMMENT_DRAFTS, useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';

const inFlight = new Set<string>();

const isAttached = (target: ChatDraftIdentity, filename: string): boolean => (
  useInputStore.getState().getAttachedFiles(target).some((file) => file.filename === filename)
);

const stillWaitsForScreenshot = (draftKey: string, draft: InlineCommentDraft, target: ChatDraftIdentity): boolean => {
  const current = useInlineCommentDraftStore.getState().drafts[draftKey]?.find((item) => item.id === draft.id);
  return Boolean(current?.screenshot && current.screenshot === draft.screenshot && !isAttached(target, current.screenshot));
};

const dropLeftScreenshots = (left: ReadonlyMap<string, string>, drafts: readonly InlineCommentDraft[], target: ChatDraftIdentity): void => {
  const stillShown = new Set(drafts.flatMap((draft) => (draft.screenshot ? [draft.screenshot] : [])));
  const input = useInputStore.getState();
  for (const [draftId, filename] of left) {
    if (drafts.some((draft) => draft.id === draftId && draft.screenshot === filename) || stillShown.has(filename)) continue;
    const attachment = input.getAttachedFiles(target).find((file) => file.filename === filename);
    if (attachment) input.removeAttachedFile(attachment.id);
  }
};

const keepStored = async (draftId: string, attachment: AttachedFile): Promise<void> => {
  if (!(await hasAnnotationScreenshot(draftId))) await saveAnnotationScreenshot(draftId, attachment);
};

const bringBack = async (draftKey: string, draft: InlineCommentDraft, target: ChatDraftIdentity): Promise<void> => {
  const attachment = await readAnnotationScreenshot(draft.id);
  if (attachment && stillWaitsForScreenshot(draftKey, draft, target)) {
    useInputStore.getState().restoreAttachedFiles([attachment], target);
  }
};

export const useAnnotationScreenshots = (
  draftKey: string | null,
  attachedFiles: readonly AttachedFile[],
  target: ChatDraftIdentity | null,
): void => {
  const drafts = useInlineCommentDraftStore(React.useCallback(
    (state) => (draftKey ? state.drafts[draftKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS),
    [draftKey],
  ));

  const shown = React.useRef<{ scope: string | null; screenshots: Map<string, string> }>({ scope: null, screenshots: new Map() });

  React.useEffect(() => {
    if (!draftKey || !target) return;
    const screenshots = new Map(drafts.flatMap((draft) => (draft.screenshot ? [[draft.id, draft.screenshot] as const] : [])));
    if (shown.current.scope === draftKey) dropLeftScreenshots(shown.current.screenshots, drafts, target);
    shown.current = { scope: draftKey, screenshots };
    const attached = new Map(attachedFiles.map((file) => [file.filename, file]));
    for (const draft of drafts) {
      if (!draft.screenshot || inFlight.has(draft.id)) continue;
      const local = attached.get(draft.screenshot);
      inFlight.add(draft.id);
      const work = local ? keepStored(draft.id, local) : bringBack(draftKey, draft, target);
      void work.finally(() => inFlight.delete(draft.id));
    }
  }, [attachedFiles, draftKey, drafts, target]);
};
